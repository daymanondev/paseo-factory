import type { ScrumTelemetry } from "./telemetry.ts";
/** Append-only workflow evidence. Invoked by the live Factory writer, never Agents. */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { FactoryError } from "../errors.ts";
import { fsyncDirectory } from "../history-stage.ts";
import { scopeDir, scrumConfigIsValid, scrumMutation } from "./config.ts";
import type { ScrumConfig } from "./config.ts";
import { artifactRefIsValid, safeId, safePath } from "./types.ts";
import type { ArtifactRef, ScrumRoleName } from "./types.ts";
export const SCRUM_POLICY_REVISION = "0032-r2";
export const PHASES = [
  "planning",
  "design",
  "readiness",
  "awaiting-ui-approval",
  "implementation",
  "qa",
  "fixing",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type RunPhase = (typeof PHASES)[number];
export type RunTrack = "small" | "backend" | "ui";
export interface RunBudgets {
  maxTasks: number;
  maxElapsedMs: number;
  maxQaFixRounds: number;
}
export interface RoleResult {
  status: "complete" | "partial" | "blocked";
  artifactRefs: ArtifactRef[];
  assumptions: {
    id: string;
    unsafe: boolean;
    resolved: boolean;
    rationale: string;
  }[];
  openQuestions: string[];
  conflicts: string[];
}
export interface Readiness {
  refs: ArtifactRef[];
  contradictions: string[];
  unsafeAssumptions: string[];
  missingCoverage: string[];
  rationale: string;
}
export interface DesignReview {
  revision: number;
  digest: string;
  refs: ArtifactRef[];
  browserEvidence: ArtifactRef[];
  decision?: "approved" | "changes_requested" | "waived";
  actor?: string;
  rationale?: string;
}
export interface RunTask {
  task: string;
  role: ScrumRoleName;
  epoch?: number;
  required: boolean;
  provider?: string;
  result?: RoleResult;
}
export interface ScrumRun {
  mode: "scrum";
  runId: string;
  initiativeId: string;
  policyRevision: string;
  configRevision: number;
  config: ScrumConfig;
  track: RunTrack;
  rationale: string;
  budgets: RunBudgets;
  revision: number;
  createdAt: string;
  phase: RunPhase;
  fixRounds: number;
  fixReservations: { task: string; requestId: string }[];
  tasks: RunTask[];
  ownedPaths: string[];
  artifacts: ArtifactRef[];
  telemetry?: ScrumTelemetry;
  qaResult?: { status: string; productSha: string; confirmedDefects: number };
  readiness?: Readiness;
  design?: DesignReview;
  blockers: string[];
  qaAudits: ArtifactRef[];
  promotions: ArtifactRef[];
  decisions: number;
}
interface BaseCommand {
  requestId: string;
  expectedRevision: number;
}
export type RunCommand = BaseCommand &
  (
    | {
        type: "phase_changed";
        phase: RunPhase;
        reason: string;
        telemetry?: ScrumTelemetry;
      }
    | {
        type: "task_reserved";
        task: string;
        role: ScrumRoleName;
        required: boolean;
      }
    | { type: "task_bound"; task: string; epoch: number }
    | {
        type: "provider_selected";
        task: string;
        epoch: number;
        provider: string;
      }
    | { type: "role_result"; task: string; result: RoleResult }
    | { type: "artifacts_recorded"; refs: ArtifactRef[] }
    | { type: "readiness_recorded"; readiness: Readiness }
    | { type: "design_review_requested"; design: DesignReview }
    | {
        type: "design_decided";
        revision: number;
        digest: string;
        decision: "approved" | "changes_requested" | "waived";
        actor: string;
        rationale: string;
      }
    | { type: "fix_reserved"; task: string }
    | {
        type: "qa_recorded";
        ref: ArtifactRef;
        result?: {
          status: string;
          productSha: string;
          confirmedDefects: number;
        };
      }
    | { type: "bundle_promoted"; ref: ArtifactRef }
    | { type: "blockers_resolved"; resolution: string }
    | { type: "blocked"; reason: string }
  );
interface RunEvent {
  revision: number;
  requestId: string;
  fingerprint: string;
  ts: string;
  payload: { type: "created"; run: ScrumRun } | RunCommand;
}
export const terminalRun = (run: ScrumRun): boolean =>
  run.phase === "completed" || run.phase === "cancelled";
function runPath(state: string, slug: string, id: string): string {
  if (!safeId(id)) throw new FactoryError("invalid-run-id", String(id));
  return join(scopeDir(state, slug), "scrum/runs", id, "events.jsonl");
}
function eventsAt(path: string): RunEvent[] {
  try {
    const bytes = readFileSync(path, "utf8");
    if (!bytes.endsWith("\n"))
      throw new Error("incomplete journal tail; restore before continuing");
    return bytes
      .trimEnd()
      .split("\n")
      .map((line, i) => {
        const e = JSON.parse(line) as RunEvent;
        if (
          e.revision !== i + 1 ||
          !e.requestId ||
          !e.payload?.type ||
          !Number.isFinite(Date.parse(e.ts))
        )
          throw new Error(`invalid event ${i + 1}`);
        return e;
      });
  } catch (error) {
    throw new FactoryError("scrum-run-unreadable", `${path}: ${String(error)}`);
  }
}
function append(path: string, event: RunEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    appendFileSync(fd, JSON.stringify(event) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}
const fingerprint = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function apply(run: ScrumRun, cmd: RunCommand, now: number): void {
  if (terminalRun(run)) throw new FactoryError("scrum-run-terminal", run.phase);
  const task =
    "task" in cmd ? run.tasks.find((t) => t.task === cmd.task) : undefined;
  switch (cmd.type) {
    case "phase_changed":
      if (!PHASES.includes(cmd.phase) || !cmd.reason?.trim())
        throw new FactoryError(
          "invalid-run-phase",
          "phase and rationale required",
        );
      // Completion is admitted only by controller after inspecting live core/git evidence.
      run.phase = cmd.phase;
      if (cmd.telemetry) run.telemetry = cmd.telemetry;
      break;
    case "task_reserved":
      if (task !== undefined) {
        if (task.role !== cmd.role)
          throw new FactoryError("task-execution-mismatch", cmd.task);
        break;
      }
      if (
        !safeId(cmd.task) ||
        !["pm", "ux", "architect", "dev", "qa"].includes(cmd.role)
      )
        throw new FactoryError("invalid-task", cmd.task);
      if (
        run.tasks.length >= run.budgets.maxTasks ||
        now - Date.parse(run.createdAt) >= run.budgets.maxElapsedMs
      )
        throw new FactoryError(
          "scrum-budget-exhausted",
          "Task/time budget exhausted",
        );
      run.tasks.push({
        task: cmd.task,
        role: cmd.role,
        required: cmd.required,
      });
      break;
    case "task_bound":
      if (!task || !Number.isSafeInteger(cmd.epoch) || cmd.epoch < 1)
        throw new FactoryError("task-binding-invalid", String(cmd.epoch));
      task.epoch = cmd.epoch;
      break;
    case "provider_selected":
      if (!task || task.epoch !== cmd.epoch || !cmd.provider)
        throw new FactoryError("task-execution-mismatch", cmd.task);
      if (task.provider !== undefined && task.provider !== cmd.provider)
        throw new FactoryError("task-provider-frozen", task.provider);
      task.provider = cmd.provider;
      break;
    case "role_result":
      if (
        !task ||
        !["complete", "partial", "blocked"].includes(cmd.result?.status) ||
        !cmd.result.artifactRefs.every(artifactRefIsValid) ||
        !Array.isArray(cmd.result.assumptions) ||
        !Array.isArray(cmd.result.conflicts) ||
        !Array.isArray(cmd.result.openQuestions)
      )
        throw new FactoryError(
          "invalid-role-result",
          "structured role result required",
        );
      task.result = cmd.result;
      if (["pm", "ux", "architect"].includes(task.role))
        run.readiness = undefined;
      break;
    case "artifacts_recorded":
      if (!cmd.refs.every(artifactRefIsValid))
        throw new FactoryError(
          "invalid-artifact-ref",
          "full commit and hash required",
        );
      for (const ref of cmd.refs)
        if (!run.ownedPaths.includes(ref.path))
          throw new FactoryError("artifact-not-owned", ref.path);
      run.readiness = undefined;
      if (
        run.design?.refs.some((old) =>
          cmd.refs.some(
            (ref) => old.path === ref.path && old.sha256 !== ref.sha256,
          ),
        )
      )
        run.design = undefined;
      run.artifacts = [
        ...run.artifacts.filter(
          (old) => !cmd.refs.some((ref) => ref.path === old.path),
        ),
        ...cmd.refs,
      ];
      break;
    case "readiness_recorded":
      if (
        !cmd.readiness.refs.every(artifactRefIsValid) ||
        !cmd.readiness.rationale?.trim()
      )
        throw new FactoryError(
          "invalid-readiness",
          "refs and rationale required",
        );
      run.readiness = cmd.readiness;
      run.phase =
        run.blockers.length ||
        cmd.readiness.contradictions.length ||
        cmd.readiness.unsafeAssumptions.length ||
        cmd.readiness.missingCoverage.length
          ? "blocked"
          : run.track === "ui"
            ? "awaiting-ui-approval"
            : "implementation";
      break;
    case "design_review_requested":
      if (
        !Number.isSafeInteger(cmd.design.revision) ||
        cmd.design.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(cmd.design.digest) ||
        !cmd.design.refs.length ||
        !cmd.design.refs.every(artifactRefIsValid) ||
        !cmd.design.browserEvidence.length ||
        !cmd.design.browserEvidence.every(artifactRefIsValid) ||
        cmd.design.decision !== undefined
      )
        throw new FactoryError(
          "invalid-design-review",
          "exact artifacts and browser evidence required",
        );
      if (run.design && cmd.design.revision <= run.design.revision)
        throw new FactoryError(
          "stale-design-revision",
          String(cmd.design.revision),
        );
      run.design = cmd.design;
      run.phase = "awaiting-ui-approval";
      break;
    case "design_decided":
      if (
        !run.design ||
        cmd.revision !== run.design.revision ||
        cmd.digest !== run.design.digest
      )
        throw new FactoryError(
          "stale-design-decision",
          "design was superseded",
        );
      if (
        !["approved", "changes_requested", "waived"].includes(cmd.decision) ||
        !cmd.actor?.trim() ||
        !cmd.rationale?.trim()
      )
        throw new FactoryError(
          "invalid-design-decision",
          "actor, decision and rationale required",
        );
      run.design = {
        ...run.design,
        decision: cmd.decision,
        actor: cmd.actor,
        rationale: cmd.rationale,
      };
      run.decisions++;
      if (cmd.decision === "changes_requested") {
        run.phase = "design";
        run.readiness = undefined;
      }
      break;
    case "fix_reserved":
      if (!safeId(cmd.task)) throw new FactoryError("invalid-task", cmd.task);
      if (run.fixReservations.some((r) => r.task === cmd.task)) break;
      if (run.fixRounds >= run.budgets.maxQaFixRounds)
        throw new FactoryError(
          "qa-fix-budget-exhausted",
          "qa-fix-budget-exhausted: escalate to Supervisor",
        );
      run.fixRounds++;
      run.fixReservations.push({ task: cmd.task, requestId: cmd.requestId });
      run.phase = "fixing";
      break;
    case "qa_recorded":
      if (!artifactRefIsValid(cmd.ref))
        throw new FactoryError("invalid-qa-ref", "hash required");
      run.qaAudits.push(cmd.ref);
      run.qaResult = cmd.result;
      if (
        cmd.result &&
        ["blocked", "inconclusive"].includes(cmd.result.status)
      ) {
        run.blockers.push(`QA ${cmd.result.status}`);
        run.phase = "blocked";
      }
      break;
    case "blockers_resolved":
      if (!cmd.resolution?.trim())
        throw new FactoryError(
          "invalid-resolution",
          "resolution evidence/rationale required",
        );
      run.blockers = [];
      break;
    case "bundle_promoted":
      if (!artifactRefIsValid(cmd.ref))
        throw new FactoryError("invalid-bundle-ref", "hash required");
      run.promotions.push(cmd.ref);
      break;
    case "blocked":
      if (!cmd.reason?.trim())
        throw new FactoryError("invalid-blocker", "reason required");
      run.blockers.push(cmd.reason);
      run.phase = "blocked";
      break;
    default:
      throw new FactoryError("invalid-run-command", "unsupported command");
  }
}
function project(events: RunEvent[]): ScrumRun {
  const first = events[0];
  if (
    first?.payload.type !== "created" ||
    !scrumConfigIsValid(first.payload.run.config)
  )
    throw new FactoryError("scrum-run-unreadable", "missing creation snapshot");
  const run = structuredClone(first.payload.run);
  for (const event of events.slice(1)) {
    if (event.payload.type === "created")
      throw new FactoryError("scrum-run-unreadable", "duplicate creation");
    apply(run, event.payload, Date.parse(event.ts));
    run.revision = event.revision;
  }
  return run;
}
export function readRun(state: string, slug: string, runId: string): ScrumRun {
  return project(eventsAt(runPath(state, slug, runId)));
}
export function listRuns(state: string, slug: string): ScrumRun[] {
  const dir = join(scopeDir(state, slug), "scrum/runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readRun(state, slug, e.name));
}
export function createScrumRun(input: {
  state: string;
  slug: string;
  runId: string;
  initiativeId: string;
  config: ScrumConfig;
  configRevision: number;
  track: RunTrack;
  rationale: string;
  requestId: string;
  budgets?: Partial<RunBudgets>;
  ownedPaths?: string[];
}): ScrumRun {
  return scrumMutation(input.state, () => {
    const path = runPath(input.state, input.slug, input.runId);
    if (existsSync(path)) {
      const first = eventsAt(path)[0];
      if (
        first.requestId === input.requestId &&
        first.fingerprint === fingerprint(input)
      )
        return readRun(input.state, input.slug, input.runId);
      throw new FactoryError("scrum-run-exists", input.runId);
    }
    if (listRuns(input.state, input.slug).some((r) => !terminalRun(r)))
      throw new FactoryError("scrum-run-busy", "one active run per Project");
    const budgets = {
      maxTasks: 24,
      maxElapsedMs: 7_200_000,
      maxQaFixRounds: 2,
      ...input.budgets,
    };
    if (
      !safeId(input.initiativeId) ||
      !["small", "backend", "ui"].includes(input.track) ||
      !input.rationale?.trim() ||
      !scrumConfigIsValid(input.config) ||
      Object.values(budgets).some((v) => !Number.isSafeInteger(v) || v < 0) ||
      budgets.maxTasks === 0 ||
      budgets.maxElapsedMs === 0
    )
      throw new FactoryError(
        "invalid-scrum-run",
        "finite positive budgets, initiative, track and rationale required",
      );
    const ownedPaths = input.ownedPaths ?? [];
    if (
      ownedPaths.some(
        (p) =>
          !safePath(p) ||
          !p.startsWith(`.scratch/${input.initiativeId}/`) ||
          !/^(?:prd\.md|DESIGN\.md|EXPERIENCE\.md|architecture\.md|sprint-backlog\.md|qa-report\.(?:json|md)|mockups\/.+|decisions\/[A-Za-z0-9._-]+\.jsonl|qa\/.+)$/.test(
            p.slice(`.scratch/${input.initiativeId}/`.length),
          ),
      )
    )
      throw new FactoryError(
        "artifact-not-owned",
        "owned paths must be explicit initiative files",
      );
    const createdAt = new Date().toISOString();
    const run: ScrumRun = {
      mode: "scrum",
      runId: input.runId,
      initiativeId: input.initiativeId,
      policyRevision: SCRUM_POLICY_REVISION,
      configRevision: input.configRevision,
      config: structuredClone(input.config),
      track: input.track,
      rationale: input.rationale,
      budgets,
      revision: 1,
      createdAt,
      phase: "planning",
      fixRounds: 0,
      fixReservations: [],
      tasks: [],
      ownedPaths,
      artifacts: [],
      blockers: [],
      qaAudits: [],
      promotions: [],
      decisions: 0,
    };
    append(path, {
      revision: 1,
      requestId: input.requestId,
      fingerprint: fingerprint(input),
      ts: createdAt,
      payload: { type: "created", run },
    });
    return run;
  });
}
function commandFingerprint(cmd: RunCommand): string {
  const { expectedRevision: _expected, ...content } = cmd;
  return fingerprint(content);
}

export function commandRun(
  state: string,
  slug: string,
  id: string,
  cmd: RunCommand,
): ScrumRun {
  return scrumMutation(state, () => {
    const path = runPath(state, slug, id),
      events = eventsAt(path);
    const prior = events.find((e) => e.requestId === cmd.requestId);
    if (prior) {
      if (prior.fingerprint !== commandFingerprint(cmd))
        throw new FactoryError("run-request-conflict", cmd.requestId);
      return project(events);
    }
    const run = project(events);
    if (!cmd.requestId || cmd.expectedRevision !== run.revision)
      throw new FactoryError(
        "run-revision-conflict",
        `run-revision-conflict: expected ${cmd.expectedRevision}, current ${run.revision}`,
      );
    const ts = new Date().toISOString();
    try {
      apply(run, cmd, Date.parse(ts));
    } catch (error) {
      if (
        error instanceof FactoryError &&
        ["scrum-budget-exhausted", "qa-fix-budget-exhausted"].includes(
          error.code,
        ) &&
        !events.some((e) => e.requestId === `${cmd.requestId}:exhausted`)
      ) {
        const blocked: RunCommand = {
          type: "blocked",
          reason: error.message,
          requestId: `${cmd.requestId}:exhausted`,
          expectedRevision: run.revision,
        };
        append(path, {
          revision: run.revision + 1,
          requestId: blocked.requestId,
          fingerprint: fingerprint(blocked),
          ts,
          payload: blocked,
        });
      }
      throw error;
    }
    run.revision++;
    append(path, {
      revision: run.revision,
      requestId: cmd.requestId,
      fingerprint: commandFingerprint(cmd),
      ts,
      payload: cmd,
    });
    return run;
  });
}
