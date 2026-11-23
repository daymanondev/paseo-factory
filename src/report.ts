import { FactoryError } from "./errors.ts";
import { WATCH_CALLOUT_THRESHOLD } from "./constants.ts";
import { projectTask } from "./task-state.ts";
import type {
  ClaimReported,
  ContractSet,
  FreshEyesWritten,
  GateFinished,
  GateQueued,
  GitBlocked,
  LedgerEvent,
  PeerAsked,
  PermitDenied,
  PermitAllowed,
  PeerHandoffFields,
  SpawnDispatched,
  WatchWritten,
} from "./events.ts";

/**
 * The six-field handoff block (ADR 0053 §4) in PEER.md's fixed handback
 * order: Outcome → Snapshot → Scope → Verification → Unknown / risk →
 * Ownership. `Snapshot` is synthesized from the attempt's own facts — the
 * resolved commit, the `factory/<task>` branch, and the execution tree —
 * never a Peer-supplied free-text field. One renderer, two readers: the
 * attempt report and the Lead's Verdict notification carry the same lines,
 * so the Peer's words arrive verbatim at both.
 */
export function handoffLines(handoff: PeerHandoffFields, snapshot: { sha?: string; branch: string; dir: string }): string[] {
  const commit = snapshot.sha === undefined || snapshot.sha.trim() === "" ? "" : ` commit \`${snapshot.sha}\` on`;
  return [
    `- Outcome: ${handoff.outcome}`,
    `- Snapshot:${commit} branch \`${snapshot.branch}\` — tree ${snapshot.dir}`,
    `- Scope: ${handoff.scope}`,
    `- Verification: ${handoff.verification}`,
    `- Unknown / risk: ${handoff.unknowns}`,
    `- Ownership: ${handoff.ownership ?? "lease returned"}`,
  ];
}

/**
 * Renders `report-<task>-<n>.md` from ledger events — every content line traces
 * to one: contract line ← contract_set, claim ← claim_reported, attested commit ←
 * gate_finished.sha, verdict ← the gate verdict, the eye's line ←
 * fresh_eyes_written, the watch's line ← watch_written. Timestamps come from
 * events, not render time (ADR 0003); the header carries the moment the Verdict
 * was established. The report states evidence and stops there: green is not
 * acceptance (ADR 0002), so no line concludes "DONE" — and the eye's and
 * watch's lines, when present, sit between the Verdict and the closing
 * language as evidence, never as a second verdict.
 */
export function renderReport(task: string, attempt: number, events: readonly LedgerEvent[]): string {
  // `retro_written` carries no task — the guard keeps the union honest.
  const taskEvents = events.filter((e): boolean => "task" in e && e.task === task);
  const latestContract = taskEvents.findLast((e): e is ContractSet => e.event === "contract_set");
  const epochEvents = latestContract === undefined ? taskEvents : taskEvents.filter((e) => e.seq >= latestContract.seq);
  const mine = epochEvents.filter((e): boolean => e.event === "contract_set" || ("attempt" in e && e.attempt === attempt));
  const contract = mine.findLast((e): e is ContractSet => e.event === "contract_set");
  const claim = mine.findLast((e): e is ClaimReported => e.event === "claim_reported");
  const queued = mine.findLast((e): e is GateQueued => e.event === "gate_queued");
  const claimLike = claim ?? queued;
  const gate = mine.findLast((e): e is GateFinished => e.event === "gate_finished");
  const eye = mine.findLast((e): e is FreshEyesWritten => e.event === "fresh_eyes_written");
  const watch = mine.findLast((e): e is WatchWritten => e.event === "watch_written");

  if (!contract || !claimLike || !gate) {
    const missing = [
      contract ? null : "contract_set",
      claimLike ? null : "claim_reported",
      gate ? null : "gate_finished",
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new FactoryError("incomplete-history", `cannot render report for ${task} attempt ${attempt}: missing ${missing}`);
  }

  const totalAttempts = new Set(
    epochEvents
      .filter((e): e is LedgerEvent & { task: string; attempt: number } => "attempt" in e)
      .map((e) => e.attempt),
  ).size;

  const lines = [
    `# ${task} — ${formatTimestamp(gate.ts)}`,
    `- Attempt: ${attempt} of ${totalAttempts}`,
    `- Contract: \`${contract.gate}\` green${contract.artifact.trim() === "" ? "" : ` · file \`${contract.artifact}\` exists`}${
      contract.scope === undefined ? "" : ` · scope: ${contract.scope.map((s) => `\`${s}\``).join(", ")}`
    }`,
    `- Workspace: ${contract.workspace}`,
    ...(chokeLines(epochEvents.filter(isChokeEventFor(task)))),
    `- Claimed @ ${formatTimestamp(claimLike.ts)}: ${claimLike.sha}`,
    ...(claimLike.agent === undefined ? [] : [`- Claimed by agent \`${claimLike.agent}\``]),
    ...(gate.sha === undefined ? [] : [`- Attested commit: \`${gate.sha}\``]),
    // The six-field handoff (ADR 0053 §4) between the claim line and the
    // Verdict evidence; pre-0053 claims carry no handoff and render unchanged.
    // A `lead_verify` mechanical re-run carries the marker instead — the Lead's
    // re-verification claims no Peer outcome, and the report says so in place
    // of the handoff block rather than forging one.
    ...(claimLike.handoff === undefined
      ? claimLike.mechanical === "lead_verify"
        ? ["- Lead verification (`lead_verify`): mechanical re-run of the Contract Gate by the Lead — no Peer handoff on this claim"]
        : []
      : handoffLines(claimLike.handoff, {
          sha: gate.sha ?? claimLike.sha,
          branch: `factory/${task}`,
          dir:
            epochEvents.findLast((e): e is SpawnDispatched => e.event === "spawn_dispatched" && e.task === task && typeof e.worktree === "string")
              ?.worktree ?? contract.workspace,
        })),
    `- Verdict: ${gate.verdict.toUpperCase()} — ${gate.note}`,
    ...(eyeLine(eye)),
    ...(watchLine(watch)),
    gate.verdict === "green"
      ? "- Evidence, not acceptance: gate exited 0 at the attested commit, artifact present. Only the Owner accepts an Attempt."
      : "- Contract not met — send the gate note back to the agent, with the reminder: do not make the tests green yourself.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The eye's one line — evidence for the Owner; a `failed` pass names its error where the Owner reads. */
function eyeLine(eye: FreshEyesWritten | undefined): string[] {
  if (eye === undefined) return [];
  const verdict = eye.outcome === "concern" ? "CONCERN" : eye.outcome === "clear" ? "CLEAR" : "FAILED";
  const suffix = eye.finding === "" ? "" : `: ${eye.finding}`;
  return [`- Fresh eyes (\`${eye.model}\`) — ${verdict}${suffix}`];
}

/**
 * The watch's one line (ticket 03 §7): the model's dated snapshot, the answers
 * sorted descending, and the ≥0.5 callout — display-only, the threshold never
 * branches anything (record-only law). A `failed` pass names its error instead
 * of guessing from partial answers.
 */
function watchLine(watch: WatchWritten | undefined): string[] {
  if (watch === undefined) return [];
  if (watch.outcome === "failed") {
    return [`- Watch — FAILED: ${watch.error ?? "no reason recorded"}`];
  }
  const answers = Object.entries(watch.answers ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1]);
  const rendered = answers.map(([name, probability]) => `${name} ${probability.toFixed(2)}`).join(", ");
  const flagged = answers.filter(([, probability]) => probability >= WATCH_CALLOUT_THRESHOLD).map(([name]) => name);
  // The model renders short (`gpt-5.4`) — the provider prefix
  // (`copilot/`) is ledger bookkeeping, not reading.
  const model = watch.model.includes("/") ? watch.model.slice(watch.model.indexOf("/") + 1) : watch.model;
  return [`- Watch (${model}) — ${answers.length} answers: ${rendered} — ≥${WATCH_CALLOUT_THRESHOLD}: ${flagged.join(", ") || "none"}`];
}

/**
 * The task's choke section (v0.0.4): one summary line plus one line per deny
 * and git block — the asks the choke judged while the task was live. Permit
 * events are task-scoped, not attempt-scoped, so the same section renders in
 * every Attempt's report. Absent when no ask was ever judged.
 */
function chokeLines(events: readonly LedgerEvent[]): string[] {
  const allowed = events.filter((e): e is PermitAllowed => e.event === "permit_allowed");
  const denied = events.filter((e): e is PermitDenied => e.event === "permit_denied");
  const blocks = events.filter((e): e is GitBlocked => e.event === "git_blocked");
  if (allowed.length + denied.length + blocks.length === 0) return [];
  const lines = [`- Choke (task-wide): ${allowed.length} ask${allowed.length === 1 ? "" : "s"} allowed, ${denied.length} denied, ${blocks.length} git blocked`];
  for (const d of denied) {
    lines.push(`  - denied @ ${formatTimestamp(d.ts)}: ${d.command === undefined ? d.name : `\`${d.command}\``} — ${d.rule}`);
  }
  for (const b of blocks) {
    lines.push(`  - git blocked @ ${formatTimestamp(b.ts)}: \`${b.command}\` — ${b.rule}`);
  }
  return lines;
}

function isChokeEventFor(task: string): (e: LedgerEvent) => boolean {
  return (e) => "task" in e && e.task === task && (e.event === "permit_allowed" || e.event === "permit_denied" || e.event === "git_blocked");
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export interface HandbackReportInput {
  task: string;
  seq: number;
  ts: string;
  contract: ContractSet;
  handoff: PeerHandoffFields;
  snapshot: { sha?: string; branch: string; dir: string };
  agent?: string;
}

/**
 * Renders `report-<task>-ask-<seq>.md` for Gate-decoupled non-`complete` claims
 * (`reopen` / `blocked` / `partial`, ADR 0069). Uses `handoffLines` so the
 * verbatim 6-Field Handoff matches Attempt reports without opening an Attempt.
 */
export function renderHandbackReport(input: HandbackReportInput): string {
  const { task, seq, ts, contract, handoff, snapshot, agent } = input;
  const lines = [
    `# ${task} — ${formatTimestamp(ts)}`,
    `- Handback: ${handoff.outcome} (\`peer_asked\` seq ${seq}, GateQueue bypassed — no Attempt opened)`,
    `- Contract: \`${contract.gate}\`${contract.artifact.trim() === "" ? "" : ` · file \`${contract.artifact}\``}${
      contract.scope === undefined ? "" : ` · scope: ${contract.scope.map((s) => `\`${s}\``).join(", ")}`
    }`,
    `- Workspace: ${contract.workspace}`,
    ...(agent === undefined || agent.trim() === "" ? [] : [`- Handed back by agent \`${agent}\``]),
    ...handoffLines(handoff, snapshot),
    "- Status: handback recorded as `peer_asked` — no Attempt consumed, not eligible for `lead_merge`.",
  ];
  return `${lines.join("\n")}\n`;
}

export interface LoopHealth {
  totalTasks: number;
  peerAskedCount: number;
  peerAskRate: number;
  contextCeilingCount: number;
  silentContextCeilingCount: number;
  genuineUnknownGaps: number;
  redAttempts: number;
  recontracts: number;
}

const ADR0068_GATE_QUEUE_BOILERPLATE = /(?:gate\s*queue|daemon\s+gate(?:\s*queue)?)/i;
const ADR0068_DEFERRAL_HINT =
  /(?:defer(?:red|ring|ral)?|async(?:hronous(?:ly)?)?|pending|not\s+pre-?run|on\s+claim|during\s+tdd|skipped\s+(?:local|pre-?claim|full\s+(?:cumulative\s+)?gate)|runs?\s+(?:async|on\s+claim|in\s+daemon))/i;
const NEGATED_GAP_PHRASE =
  /\b(?:no|none|nothing|not|without|zero)\s+(?:known\s+|remaining\s+|other\s+)?(?:checks?\s+|tests?\s+)?(?:skipped|failed|blocked|missing|contradictions?)\b/gi;
const GENUINE_GAP_KEYWORD =
  /\b(?:cannot|can't|missing|skipped|contradict(?:s|ed|ing|ion)?|out\s+of\s+scope|failed|blocked)\b/i;

function hasGenuineUnknownGap(unknowns: string): boolean {
  const remainingLines = unknowns
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !(ADR0068_GATE_QUEUE_BOILERPLATE.test(line) && ADR0068_DEFERRAL_HINT.test(line)));
  if (remainingLines.length === 0) return false;
  const cleaned = remainingLines.join("\n").replace(NEGATED_GAP_PHRASE, " ");
  return GENUINE_GAP_KEYWORD.test(cleaned);
}

/**
 * Pure deterministic Loop Health digest computed from Ledger events (ADR 0069).
 */
export function computeLoopHealth(events: readonly LedgerEvent[]): LoopHealth {
  const contractCounts = new Map<string, number>();
  const tasksWithPeerAsk = new Set<string>();
  const completeClaimsByAttempt = new Map<string, PeerHandoffFields>();
  let peerAskedCount = 0;
  let redAttempts = 0;

  for (const event of events) {
    if (event.event === "contract_set") {
      contractCounts.set(event.task, (contractCounts.get(event.task) ?? 0) + 1);
    } else if (event.event === "peer_asked") {
      peerAskedCount += 1;
      tasksWithPeerAsk.add((event as PeerAsked).task);
    } else if (event.event === "gate_finished" && event.verdict === "red") {
      redAttempts += 1;
    } else if ((event.event === "gate_queued" || event.event === "claim_reported") && event.handoff !== undefined) {
      const epochIndex = contractCounts.get(event.task) ?? 0;
      const key = `${event.task}\0${epochIndex}\0${event.attempt}`;
      if (event.handoff.outcome === "complete") {
        completeClaimsByAttempt.set(key, event.handoff);
      } else {
        completeClaimsByAttempt.delete(key);
      }
    }
  }

  const contractedTasks = [...contractCounts.keys()];
  const totalTasks = contractedTasks.length;
  let contractedTasksWithAsk = 0;
  let contextCeilingCount = 0;
  let silentContextCeilingCount = 0;
  let recontracts = 0;

  for (const task of contractedTasks) {
    recontracts += Math.max(0, (contractCounts.get(task) ?? 0) - 1);
    if (tasksWithPeerAsk.has(task)) contractedTasksWithAsk += 1;
    const state = projectTask(events, task);
    if (state.closed !== undefined && /context[-_ ]?ceiling/i.test(state.closed.reason)) {
      contextCeilingCount += 1;
      if (!state.epoch.some((e) => e.event === "peer_asked")) {
        silentContextCeilingCount += 1;
      }
    }
  }

  let genuineUnknownGaps = 0;
  for (const handoff of completeClaimsByAttempt.values()) {
    if (hasGenuineUnknownGap(handoff.unknowns)) {
      genuineUnknownGaps += 1;
    }
  }

  return {
    totalTasks,
    peerAskedCount,
    peerAskRate: totalTasks === 0 ? 0 : contractedTasksWithAsk / totalTasks,
    contextCeilingCount,
    silentContextCeilingCount,
    genuineUnknownGaps,
    redAttempts,
    recontracts,
  };
}

/** Compact 3-line Loop Health summary for `supervisor_read_ledger` (ADR 0069). */
export function formatLoopHealthLines(health: LoopHealth): string[] {
  const pct = health.totalTasks === 0 ? "0%" : `${Math.round(health.peerAskRate * 100)}%`;
  return [
    "Loop Health:",
    `- tasks=${health.totalTasks} peer_asked=${health.peerAskedCount} (${pct}) · recontracts=${health.recontracts} red_attempts=${health.redAttempts}`,
    `- context_ceiling=${health.contextCeilingCount} (silent=${health.silentContextCeilingCount}) · genuine_unknown_gaps=${health.genuineUnknownGaps}`,
  ];
}
