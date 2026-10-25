import { FactoryError } from "./errors.ts";
import { WATCH_CALLOUT_THRESHOLD } from "./constants.ts";
import type {
  ClaimReported,
  ContractSet,
  FreshEyesWritten,
  GateFinished,
  GitBlocked,
  LedgerEvent,
  PermitDenied,
  PermitAllowed,
  WatchWritten,
} from "./events.ts";

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
  const gate = mine.findLast((e): e is GateFinished => e.event === "gate_finished");
  const eye = mine.findLast((e): e is FreshEyesWritten => e.event === "fresh_eyes_written");
  const watch = mine.findLast((e): e is WatchWritten => e.event === "watch_written");

  if (!contract || !claim || !gate) {
    const missing = [
      contract ? null : "contract_set",
      claim ? null : "claim_reported",
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
    `- Claimed @ ${formatTimestamp(claim.ts)}: ${claim.sha}`,
    ...(claim.agent === undefined ? [] : [`- Claimed by agent \`${claim.agent}\``]),
    ...(gate.sha === undefined ? [] : [`- Attested commit: \`${gate.sha}\``]),
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
