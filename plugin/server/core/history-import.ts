/** Pure, conservative admission plans. Original snapshots and citations remain
 * in their source namespace; the live Ledger owner alone activates a plan.
 */
import { FactoryError } from "./errors.ts";
import { createHash } from "node:crypto";
import { canonicalHistoryJson, historyHash, planLegacyIdentity, remapLedgerReferences, semanticEventContent } from "./history-identity.ts";
import type { LegacyIdentityMapping } from "./history-identity.ts";
import { parseLedgerJsonl } from "./ledger-validation.ts";
import type { LedgerEvent } from "./events.ts";
import { isAbsolute } from "node:path";
import { artifactPathProblem } from "./artifact.ts";
import { eventAllowsUnboundEpoch, MAX_ATTEMPTS } from "./events.ts";
import { projectTask } from "./task-state.ts";

export interface HistoryArtifact {
  /** Source-local filename, never rewritten into an active local path. */
  path: string;
  bytes: Uint8Array;
}
export interface HistoryImportSource {
  nodeId: string;
  lines: string;
  /** Exact transport bytes when available, including invalid UTF-8. */
  bytes?: Uint8Array;
  snapshotHash?: string;
  identityMapping?: LegacyIdentityMapping;
  artifacts?: readonly HistoryArtifact[];
}
/** Facts supplied by the owner's filesystem/Git adapter, never by untrusted
 * request attribution. A remote string alone cannot establish local binding.
 */
export interface VerifiedImportFile { eventId: string; path: string }
export interface VerifiedImportBinding {
  epochId: string;
  workspace: string;
  base?: string;
  worktree?: string;
  commits?: readonly string[];
  /** Resolved source Claim identity for symbolic/non-hex claimed revisions. */
  claims?: readonly { eventId: string; sha: string }[];
  files?: readonly VerifiedImportFile[];
  artifactPresent?: boolean;
  landedCommits?: readonly string[];
}
export interface ImportConflict { sourceId?: string; eventId?: string; reason: string }
export interface ImportSourcePlan {
  id: string;
  holderId: string;
  namespace?: string;
  lines: string;
  bytes: Uint8Array;
  artifacts: HistoryArtifact[];
  identityMapping?: LegacyIdentityMapping;
  sequenceMap: { sourceSeq: number; eventId: string; epochId?: string; localSeq?: number }[];
  diagnostics: string[];
}
export interface HistoryImportPlan {
  version: 1;
  id: string;
  baseHash: string;
  status: "ready" | "duplicate" | "conflicted";
  events: LedgerEvent[];
  additions: LedgerEvent[];
  duplicates: string[];
  lines: string;
  conflicts: ImportConflict[];
  sources: ImportSourcePlan[];
  diagnostics: string[];
}

export interface HistoryImportInput {
  existingLines: string;
  sources: readonly HistoryImportSource[];
  bindings?: readonly VerifiedImportBinding[];
  /** Owner-verified files for factory-level evidence such as Retro. */
  files?: readonly VerifiedImportFile[];
}

export function planHistoryImport(input: HistoryImportInput): HistoryImportPlan {
  const sources: ImportSourcePlan[] = input.sources.map((source) => ({ id: createHash("sha256").update(source.bytes ?? source.lines).digest("hex"), bytes: new Uint8Array(source.bytes ?? Buffer.from(source.lines)), holderId: source.nodeId, lines: source.lines, artifacts: (source.artifacts ?? []).map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) })), ...(source.identityMapping === undefined ? {} : { identityMapping: structuredClone(source.identityMapping) }), sequenceMap: [], diagnostics: [] }));
  const plan: HistoryImportPlan = { version: 1, id: historyHash(canonicalHistoryJson(sources.map((source) => ({ id: source.id, holder: source.holderId, artifacts: source.artifacts.map((file) => ({ path: file.path, hash: createHash("sha256").update(file.bytes).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path)) })).sort((a, b) => a.id.localeCompare(b.id) || a.holder.localeCompare(b.holder)))), baseHash: historyHash(input.existingLines), status: "duplicate", events: [], additions: [], duplicates: [], lines: input.existingLines, conflicts: [], sources, diagnostics: [] };
  const local = parseLedgerJsonl(input.existingLines);
  if (local.corrupt !== undefined) {
    plan.status = "conflicted"; plan.conflicts.push({ reason: `local history: ${local.corrupt}` }); return plan;
  }
  plan.events = [...local.events];
  if (input.existingLines !== "" && !input.existingLines.endsWith("\n")) plan.conflicts.push({ reason: "local unacknowledged final tail requires writer recovery before import" });
  const bindingEpochs = new Set<string>();
  for (const binding of input.bindings ?? []) {
    if (bindingEpochs.has(binding.epochId)) plan.conflicts.push({ reason: `multiple local binding declarations for epoch ${binding.epochId}` });
    bindingEpochs.add(binding.epochId);
  }
  const contexts = new Map<string, { event: LedgerEvent; context: readonly LedgerEvent[] }>();
  for (const event of local.events) if (event.event_id !== undefined) contexts.set(event.event_id, { event, context: local.events });
  const histories = new Map<string, string[]>();
  const taskHistories = (events: readonly LedgerEvent[]) => {
    const tasks = new Map<string, string[]>();
    for (const event of events) if ("task" in event && typeof event.task === "string") {
      const ids = tasks.get(event.task) ?? [];
      ids.push(event.event_id!);
      tasks.set(event.task, ids);
    }
    return tasks;
  };
  for (const [task, ids] of taskHistories(local.events)) histories.set(task, ids);
  const candidates: { event: LedgerEvent; context: readonly LedgerEvent[]; sourceId: string }[] = [];
  for (const [index, source] of input.sources.entries()) {
    const stored = sources[index]!;
    if (!Buffer.from(source.lines).equals(Buffer.from(stored.bytes))) { plan.conflicts.push({ sourceId: stored.id, reason: "source text is not a byte-preserving UTF-8 representation" }); continue; }
    const parsed = parseLedgerJsonl(source.lines);
    if (parsed.corrupt !== undefined) { plan.conflicts.push({ sourceId: stored.id, reason: parsed.corrupt }); continue; }
    for (const reason of validateHistoryCausality(parsed.events)) plan.conflicts.push({ sourceId: stored.id, reason });
    if (source.lines !== "" && !source.lines.endsWith("\n")) stored.diagnostics.push("unacknowledged final tail retained outside imported evidence");
    stored.namespace = parsed.events.find((event) => event.event === "ledger_schema")?.ledger_id;
    if (source.identityMapping !== undefined) {
      // For an already-v2 snapshot the planner never invents a fence or
      // provenance; this reuses the persisted-prefix mapping validator.
      const checked = planLegacyIdentity(source.lines, { holderId: source.nodeId, writerId: "import-plan-only", previous: source.identityMapping });
      if (!checked.ok) plan.conflicts.push(...checked.conflicts.map((reason) => ({ sourceId: stored.id, reason })));
    }
    if (source.snapshotHash !== undefined && source.snapshotHash !== stored.id) { plan.conflicts.push({ sourceId: stored.id, reason: "snapshot hash differs from original bytes" }); continue; }
    if (parsed.events.some((event) => event.schema_version !== 2) || !local.events.some((event) => event.event === "ledger_schema")) { plan.conflicts.push({ sourceId: stored.id, reason: "explicit legacy migration and identity mapping are required before import" }); continue; }
    for (const [task, ids] of taskHistories(parsed.events)) {
      const known = histories.get(task);
      if (known !== undefined && ids.slice(0, Math.min(ids.length, known.length)).some((id, at) => id !== known[at])) plan.conflicts.push({ sourceId: stored.id, reason: `Task ${task} has divergent history; a causal continuation is not demonstrated` });
      else if (known === undefined || ids.length > known.length) histories.set(task, ids);
    }
    for (const event of parsed.events) {
      if (event.event === "ledger_schema") continue;
      stored.sequenceMap.push({ sourceSeq: event.seq, eventId: event.event_id!, ...(event.epoch_id === undefined ? {} : { epochId: event.epoch_id }) });
      const known = contexts.get(event.event_id!);
      if (known !== undefined) {
        if (semanticEventContent(known.event, known.context) !== semanticEventContent(event, parsed.events)) plan.conflicts.push({ sourceId: stored.id, eventId: event.event_id, reason: "same stable identity has contradictory semantic content" });
        else plan.duplicates.push(event.event_id!);
      } else {
        candidates.push({ event, context: parsed.events, sourceId: stored.id });
        contexts.set(event.event_id!, { event, context: parsed.events });
      }
    }
  }
  // Independent Tasks have no causal order between them. A stable identity
  // tie-break makes numbering reproducible without making clocks a judge.
  candidates.sort((a, b) => {
    const taskA = "task" in a.event ? a.event.task ?? "" : "";
    const taskB = "task" in b.event ? b.event.task ?? "" : "";
    if (taskA !== taskB) return taskA < taskB ? -1 : 1;
    if (taskA !== "") return histories.get(taskA)!.indexOf(a.event.event_id!) - histories.get(taskA)!.indexOf(b.event.event_id!);
    return a.event.event_id! < b.event.event_id! ? -1 : 1;
  });
  let nextSeq = (local.events.at(-1)?.seq ?? 0) + 1;
  const allocated = candidates.map(({ event }) => ({ ...event, seq: nextSeq++ }));
  const resulting = [...local.events, ...allocated];
  if (allocated.some((event) => !Number.isSafeInteger(event.seq))) plan.conflicts.push({ reason: "no safe local sequence remains for import additions" });
  const additions: LedgerEvent[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const bound = candidate.event.epoch_id === undefined ? undefined : input.bindings?.find((binding) => binding.epochId === candidate.event.epoch_id);
    for (const reason of bindingProblems(candidate.event, resulting, bound, input.files ?? [])) plan.conflicts.push({ sourceId: candidate.sourceId, eventId: candidate.event.event_id, reason });
    const mapped = remapLedgerReferences(candidate.event, candidate.context, resulting);
    if (!mapped.ok) plan.conflicts.push(...mapped.reasons.map((reason) => ({ sourceId: candidate.sourceId, eventId: candidate.event.event_id, reason })));
    else additions.push({ ...mapped.event, seq: allocated[index]!.seq });
  }
  const preparedLines = input.existingLines + additions.map((event) => JSON.stringify(event) + "\n").join("");
  const prepared = parseLedgerJsonl(preparedLines);
  if (prepared.corrupt !== undefined) plan.conflicts.push({ reason: `prepared history: ${prepared.corrupt}` });
  else for (const reason of validateHistoryCausality(prepared.events)) plan.conflicts.push({ reason: `prepared history: ${reason}` });
  if (plan.conflicts.length > 0) { plan.status = "conflicted"; return plan; }
  plan.additions = additions;
  plan.events = [...local.events, ...additions];
  plan.lines = preparedLines;
  plan.status = additions.length === 0 ? "duplicate" : "ready";
  for (const source of sources) for (const entry of source.sequenceMap) entry.localSeq = plan.events.find((event) => event.event_id === entry.eventId)?.seq;
  return plan;
}


/** Pure lifecycle validation for import and prepared migration output. Binding
 * and transport checks are deliberately separate; attribution confers no role.
 */
export function validateHistoryCausality(events: readonly LedgerEvent[]): string[] {
  const reasons: string[] = [];
  const prior: LedgerEvent[] = [];
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  for (const event of events) {
    const reject = (reason: string) => reasons.push(`seq ${event.seq}: ${reason}`);
    if ("task" in event && typeof event.task === "string") {
      const state = projectTask(prior, event.task);
      const attempt = "attempt" in event ? state.attempts.find((attempt) => attempt.attempt === event.attempt) : undefined;
      const claim = attempt?.events.find((item) => item.event === "claim_reported");
      if (event.event !== "contract_set" && !eventAllowsUnboundEpoch(event.event) && state.contract === undefined) reject("Task fact has no prior Contract");
      if (event.event === "contract_set") {
        if (!text(event.workspace) || !isAbsolute(event.workspace) || !text(event.gate) || typeof event.artifact !== "string" || (text(event.artifact) && artifactPathProblem(event.artifact) !== undefined)) reject("Contract has invalid Workspace, Gate or Artifact criteria");
        if (state.inFlightAttempt !== undefined) reject("Contract replaces an open Claim pipeline");
        if (state.acceptance !== undefined) reject("Contract follows Task acceptance");
      }
      if (event.event === "claim_reported") {
        if (!text(event.sha)) reject("Claim SHA is missing");
        if (state.inFlightAttempt !== undefined) reject("Claim arrived before the previous Report");
        if (event.attempt !== state.maxAttempt + 1 || event.attempt > MAX_ATTEMPTS) reject("Claim does not advance the Contract epoch's Attempt counter");
        if (state.acceptance !== undefined) reject("Claim follows Task acceptance");
      }
      if (event.event === "gate_started") {
        if (claim === undefined || attempt?.gate !== undefined || attempt?.events.some((item) => item.event === "gate_started") || event.cmd !== state.contract?.gate) reject("Gate start has no unique prior Claim or disagrees with the Contract command");
      }
      if (event.event === "gate_finished") {
        if (claim === undefined) reject("Gate has no prior Claim for this Task/epoch/Attempt");
        if (attempt?.gate !== undefined) reject("Gate outcome already exists for this Attempt");
        if (!["red", "green"].includes(event.verdict) || (event.exit !== null && (!Number.isInteger(event.exit) || event.exit < 0)) || typeof event.note !== "string") reject("Gate outcome has invalid factual fields");
        if (event.verdict === "green" && (event.exit !== 0 || !text(event.sha))) reject("green Gate requires exit 0 and an attested SHA");
        if (claim?.event === "claim_reported" && text(event.sha) && /^[a-f0-9]+$/i.test(claim.sha) && !event.sha.startsWith(claim.sha)) reject("Gate SHA disagrees with its Claim");
      }
      if (event.event === "fresh_eyes_written") {
        if (attempt?.gate?.verdict !== "green" || state.contract?.freshEyes !== true || attempt.review !== undefined || attempt.reportComplete) reject("review has no unique pending required green Attempt");
        if (!["clear", "concern", "failed"].includes(event.outcome) || !text(event.model) || typeof event.finding !== "string" || !Number.isFinite(event.durationMs) || event.durationMs < 0) reject("review has invalid outcome fields");
      }
      if (event.event === "watch_written") {
        if (attempt?.gate === undefined || state.contract?.watch !== true || attempt.events.some((item) => item.event === "watch_written") || attempt.reportComplete) reject("Watch has no unique pending enabled Gate outcome");
        if (state.contract?.freshEyes && attempt?.gate?.verdict === "green" && attempt.review === undefined) reject("Watch precedes required review completion");
      }
      if (event.event === "report_written") {
        if (attempt?.gate === undefined || attempt.reportComplete || !text(event.path)) reject("Report has no unique prior Gate outcome");
        // Restart can produce a Report with missing required review. That is
        // incomplete evidence in projectTask, never an invented CLEAR.
      }
      if (event.event === "attempt_accepted") {
        if (attempt?.gate?.verdict !== "green") reject("acceptance has no prior green Gate for this Task/epoch/Attempt");
        if (state.acceptance !== undefined && (state.acceptance.landing !== "pending-conflict" || state.acceptance.attempt !== event.attempt)) reject("acceptance contradicts a prior settled acceptance");
      }
      if (event.event === "needs_human") {
        if ("attempt" in event.evidence && event.evidence.attempt !== MAX_ATTEMPTS) reject("Needs-human ceiling evidence names another Attempt");
        if ("denial" in event.evidence && event.reason === "denied-again" && event.evidence.denial <= event.evidence.repoke) reject("denied-again evidence does not follow the re-poke");
        if ("denial" in event.evidence && event.reason === "silent-after-repoke" && event.evidence.denial >= event.evidence.repoke) reject("silent-after-repoke evidence does not precede the re-poke");
        if ("spawn" in event.evidence && event.evidence.respawn <= event.evidence.spawn) reject("respawn evidence does not follow its spawn");
      }
    }
    prior.push(event);
  }
  return reasons;
}

function bindingProblems(event: LedgerEvent, events: readonly LedgerEvent[], binding: VerifiedImportBinding | undefined, files: readonly VerifiedImportFile[]): string[] {
  if (event.event === "retro_written" && event.outcome === "written" && (typeof event.proposalsPath !== "string" || !files.some((file) => file.eventId === event.event_id && file.path === event.proposalsPath))) return ["Retro proposals file has no verified local event binding; citations remain in the source namespace"];
  if (!("task" in event) || typeof event.task !== "string" || event.epoch_id === undefined) return [];
  const contract = events.find((candidate) => candidate.event === "contract_set" && candidate.event_id === event.epoch_id);
  if (contract?.event !== "contract_set" || binding === undefined || binding.workspace !== contract.workspace || !isAbsolute(binding.workspace)) return [`Contract Workspace ${String(contract?.event === "contract_set" ? contract.workspace : event.epoch_id)} has no verified exact-root local binding; relocated roots require explicit materialization before admission`];
  const reasons: string[] = [];
  if (contract.base !== undefined && binding.base !== contract.base) reasons.push("Contract base commit has no verified local binding");
  if (event.event === "spawn_dispatched" && event.worktree !== undefined && (binding.worktree !== event.worktree || !isAbsolute(event.worktree))) reasons.push("spawn has no verified local Task worktree binding");
  if (event.event === "gate_finished") {
    if (event.verdict === "green") {
      if (!events.some((candidate) => candidate.event === "gate_started" && candidate.epoch_id === event.epoch_id && candidate.attempt === event.attempt && candidate.seq < event.seq)) reasons.push("green Gate has no prior Gate start evidence; retain the original history for resolution");
      if (typeof event.outputPath !== "string" || event.outputPath.trim() === "") reasons.push("green Gate has no output log with a verified local event binding");
    }
    if (event.sha !== undefined && !binding.commits?.includes(event.sha)) reasons.push("Gate commit is unavailable in the verified local Workspace");
    const claim = events.find((candidate) => candidate.event === "claim_reported" && candidate.epoch_id === event.epoch_id && candidate.attempt === event.attempt);
    if (event.sha !== undefined && claim?.event === "claim_reported" && !/^[a-f0-9]+$/i.test(claim.sha) && !binding.claims?.some((resolution) => resolution.eventId === claim.event_id && resolution.sha === event.sha)) reasons.push("symbolic Claim has no demonstrated commit resolution; current HEAD cannot stand in for source evidence");
    if (event.verdict === "green" && contract.artifact.trim() !== "" && binding.artifactPresent !== true) reasons.push("green Gate Artifact is unavailable in the verified execution Workspace");
  }
  if (event.event === "attempt_accepted") {
    const gate = events.findLast((candidate) => candidate.event === "gate_finished" && candidate.epoch_id === event.epoch_id && candidate.attempt === event.attempt);
    if (event.landing === "pending-conflict" || gate?.event !== "gate_finished" || gate.sha === undefined || !binding.landedCommits?.includes(gate.sha)) reasons.push("imported acceptance does not establish verified local landing");
  }
  const path = event.event === "gate_finished" ? event.outputPath : event.event === "report_written" ? event.path : undefined;
  if (path !== undefined && !binding.files?.some((file) => file.eventId === event.event_id && file.path === path)) reasons.push(`evidence file ${path} has no verified local event binding`);
  return reasons;
}

/** Compatibility string API: callers either get a validated plan's text or
 * an actionable refusal carrying all original sources. No silent partial merge.
 */
export class HistoryImportError extends FactoryError {
  readonly plan: HistoryImportPlan;
  constructor(plan: HistoryImportPlan) {
    super("history-import-conflict", `history import retained for resolution: ${plan.conflicts.map((conflict) => conflict.reason).join("; ")}`);
    this.name = "HistoryImportError";
    this.plan = plan;
  }
}
export function reconcileHistory(existingLines: string, sources: readonly HistoryImportSource[], options: Pick<HistoryImportInput, "bindings" | "files"> = {}): string {
  const plan = planHistoryImport({ existingLines, sources, ...options });
  if (plan.status === "conflicted") throw new HistoryImportError(plan);
  return plan.lines;
}
