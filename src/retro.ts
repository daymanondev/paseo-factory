/**
 * The Retro (v0.0.7, tickets 01–04): the on-demand, Owner-invoked pass over
 * the whole recorded history. The plugin builds the ledger into a per-task
 * digest (contracts whole, attempt lifecycles, every denial/block/refusal,
 * the permit parade rolled to one count-line per task), attaches all reports
 * whole and the red Attempts' gate logs, prompts the `retro` lane headless
 * and tool-less — since v0.0.13 (ADR 0009 §3) that lane lives in
 * `<stateDir>/lanes.json` (default `pi/zai/glm-5.3`), any CLI family, the
 * shared lane runner — and strict-parses one JSON object of proposals out of
 * the response. Since v0.0.89 (ADR 0045 §4) the digest is deduplicated —
 * each Task's LATEST contract whole, superseded drafts as 1-line `seq`
 * headers, one read per Report path — and the parse strips an optional
 * enclosing Markdown code fence before validating. Every Proposal cites
 * ledger seq evidence; the factory
 * assigns R1…Rn ids; the pass writes `retro-<date>.md` in the stateDir
 * first, then exactly one `retro_written` ledger line (the first
 * factory-level event) lands — file before line, so a death between leaves
 * an orphan file that never happened and a line without a file cannot
 * occur. Nothing downstream branches on the proposals: the factory proposes,
 * only the Owner ratifies.
 *
 * Since v0.1.0 (ADR 0048 §4) the pass carries the Recurrence Guard and the
 * 4-Line Owner Ratification layout: the parse demands >= 2 DISTINCT seqs per
 * proposal (duplicates collapse, first-seen order) and caps the output at
 * the 2 highest-impact proposals; the digest optionally embeds the bounded
 * Project notebook; the rendered file cites `T-xx (seq N)` Task-resolved
 * evidence and lays each proposal out as the Owner's 4-line ratification
 * card (`Chuyện gì đã lặp lại` → `Nguyên nhân gốc` → `Nếu duyệt sẽ sửa gì
 * (Preview diff)` → `Tác dụng`).
 *
 * Refusals write no ledger line (nothing changed, so nothing is recorded —
 * the workspace-conflict precedent): the retro lane's CLI unusable, or a
 * same-day successful Retro already on the ledger. Technical failures
 * (CLI error, timeout, parse fail) are the opposite — a `failed` line with
 * the error named, no file written, and a same-day retry stays legal.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RETRO_TOTAL_BUDGET_MS } from "./constants.ts";
import { laneCliAvailable, laneCliInvocation, loadLanes, runLaneCli } from "./lanes.ts";
import type { CopilotRunner } from "./watch.ts";
import type { LedgerEvent, RetroWritten } from "./events.ts";

/** One transient retry — the watch's discipline; the budget covers both tries. */
const MAX_ATTEMPTS = 2;

/**
 * The retro's whole availability surface: the retro lane loads and its CLI
 * answers `--version` (the watch's amendment-2 precedent, generalized).
 * `factory.retro()` refuses before any ask on a `ok: false` here; `probe`
 * overrides the real version probe (tests) and receives the lane. The
 * optional `projectSlug` (v0.0.38, ADR 0026 §1) resolves the retro lane
 * from the Project's own lanes.json override, falling back to the machine
 * table when the Project never named one.
 */
export function retroLaneAvailable(
  stateDir: string,
  probe?: (lane: string) => boolean,
  projectSlug?: string,
): { ok: true; lane: string } | { ok: false; reason: string } {
  const scope = projectSlug?.trim();
  const lanes = loadLanes(stateDir, scope === "" ? undefined : scope);
  if (!lanes.ok) return { ok: false, reason: lanes.reason };
  const lane = lanes.lanes.retro;
  const invocation = laneCliInvocation(lane);
  if (invocation === undefined) {
    return {
      ok: false,
      reason: `lane ${lane} has no headless tool-less CLI form — use pi/<model>, copilot/<model> or claude/<model>`,
    };
  }
  const usable = probe === undefined ? laneCliAvailable(lane) : probe(lane);
  if (!usable) {
    return {
      ok: false,
      reason: `the ${invocation.command} CLI is not usable on PATH (lane ${lane}) — install and auth it for the daemon user; the CLI carries the pass's auth, there is no key file`,
    };
  }
  return { ok: true, lane };
}

// ---- the digest -------------------------------------------------------------------

/** What one Retro run read, with the digest text itself — the file header's corpus facts. */
export interface RetroCorpus {
  /** The whole corpus as one prompt-shaped string: per-task blocks, factory level, reports. */
  digest: string;
  /** Ledger events read (the digest's ground truth count). */
  eventsRead: number;
  /** How many per-task blocks the digest carries. */
  taskBlocks: number;
  /** How many reports ride whole. */
  reports: number;
  /** How many red-attempt gate logs are attached. */
  redGateLogs: number;
  /** Every seq in the ledger — the parse validates cited evidence against this set. */
  knownSeqs: ReadonlySet<number>;
}

/**
 * The boilerplate PATH export the daemon prepends to shell lines — stripped
 * from digested commands, and only this: the git verbs themselves stay, they
 * ARE the evidence (ticket 03 item 1).
 */
const PATH_EXPORT_PREFIX = /^export PATH=\S+ && /;

function stripped(command: string): string {
  return command.replace(PATH_EXPORT_PREFIX, "");
}

function renderContract(evt: Extract<LedgerEvent, { event: "contract_set" }>): string[] {
  const facts = [
    `\`contract\` gate=\`${evt.gate}\``,
    `artifact=${evt.artifact}`,
    ...(evt.scope === undefined || evt.scope.length === 0 ? [] : [`scope=[${evt.scope.join(", ")}]`]),
    ...(evt.base === undefined ? [] : [`base=${evt.base}`]),
    ...(evt.watch === undefined ? [] : ["watch=on"]),
    ...(evt.freshEyes === undefined ? [] : ["fresh-eyes=on"]),
  ].join(" ");
  return [`[${evt.seq}] ${facts}`, ...(evt.description === undefined ? [] : [`     description: ${evt.description}`])];
}

function renderTaskEvent(evt: LedgerEvent, stateDir: string, attached: { logs: number }): string[] {
  switch (evt.event) {
    case "spawn_dispatched":
      return [`[${evt.seq}] spawn_dispatched provider=${evt.provider} arity=${evt.arity}`];
    case "spawn_refused":
      return [`[${evt.seq}] spawn_refused rule=${evt.rule} — ${evt.reason}`];
    case "meter_written": {
      // The whole-run cost fact, verbatim fields (v0.0.8) — absent fields
      // stay absent; the dollars are a lane estimate, never an invoice.
      const usage = Object.entries(evt.usage)
        .map(([field, value]) => `${field}=${value}`)
        .join(" ");
      return [`[${evt.seq}] meter provider=${evt.provider} usage={${usage}}${evt.agent === undefined ? "" : ` agent=${evt.agent}`}`];
    }
    case "claim_reported":
      return [
        `[${evt.seq}] claim attempt=${evt.attempt} sha=${evt.sha}${evt.agent === undefined ? "" : ` agent=${evt.agent}`}`,
      ];
    case "gate_finished": {
      const line =
        `[${evt.seq}] gate attempt=${evt.attempt} exit=${evt.exit ?? "null"} verdict=${evt.verdict}` +
        ` note=${evt.note}` +
        (evt.outputPath === undefined ? "" : ` gate-log=${basename(evt.outputPath)}`);
      // Only red Attempts carry their gate log — green logs are passing-TAP
      // bulk, and the red ones hold the failure text the 200-char note clips
      // (ticket 01's measured evidence).
      if (evt.verdict !== "red" || evt.outputPath === undefined) return [line];
      attached.logs += 1;
      let content: string;
      try {
        content = readFileSync(join(stateDir, basename(evt.outputPath)), "utf8");
      } catch {
        content = "[gate log unavailable]";
      }
      return [line, ...content.split("\n").map((l) => `     | ${l}`)];
    }
    case "fresh_eyes_written":
      return [
        `[${evt.seq}] fresh_eyes attempt=${evt.attempt} model=${evt.model} outcome=${evt.outcome} duration=${evt.durationMs}ms finding: ${evt.finding}`,
      ];
    case "watch_written": {
      const tail =
        evt.outcome === "written"
          ? `answers=${JSON.stringify(evt.answers ?? {})}`
          : `error=${evt.error ?? "(no reason recorded)"}`;
      return [`[${evt.seq}] watch attempt=${evt.attempt} model=${evt.model} outcome=${evt.outcome} duration=${evt.durationMs}ms ${tail}`];
    }
    case "report_written":
      return [`[${evt.seq}] report attempt=${evt.attempt} file=${basename(evt.path)}`];
    case "attempt_accepted":
      return [`[${evt.seq}] ACCEPTED attempt=${evt.attempt}`];
    case "permit_denied":
      return [
        `[${evt.seq}] permit_denied rule=${evt.rule} — ${evt.reason}` +
          (evt.command === undefined ? "" : ` — ${stripped(evt.command)}`),
      ];
    case "git_blocked":
      return [
        `[${evt.seq}] git_blocked rule=${evt.rule} — ${evt.reason} — ${stripped(evt.command)}` +
          (evt.agent === undefined ? "" : ` agent=${evt.agent}`),
      ];
    case "contract_set":
      return renderContract(evt);
    default:
      // permit_allowed rolls into the parade line; gate_started is dropped
      // (byte-identical to the contract's gate 45/45 on the real corpus).
      return [];
  }
}

/** `permit parade: 186 allowed (Bashx120 Editx30 …)` — one count-line per task, counts descending. */
function paradeLine(allows: readonly Extract<LedgerEvent, { event: "permit_allowed" }>[]): string | undefined {
  if (allows.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const allow of allows) counts.set(allow.name, (counts.get(allow.name) ?? 0) + 1);
  const rendered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, count]) => `${name}x${count}`)
    .join(" ");
  return `permit parade: ${allows.length} allowed (${rendered})`;
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * Builds the Retro's whole corpus from the ledger (ticket 03 item 1, the
 * feed scout's recipe as measured): per-task blocks in first-seen order,
 * each carrying the contract complete, dispatch/refusals, full attempt
 * lifecycles, watch + fresh-eyes answers verbatim, every
 * denial/block/refusal verbatim (only the boilerplate PATH export stripped),
 * the parade rolled to one count-line, and the red Attempts' gate logs
 * attached; then the factory-level lines (prior Retros one per line, untasked
 * git blocks), then every report whole — bulk last, like the watch's state.
 * No caps, no `[truncated]` markers in v1; `tailWithMarker` is the named
 * precedent if a future corpus grows. `seq` stays on every line — proposals
 * cite it.
 *
 * Deduplication (v0.0.89, ADR 0045 §4): only each Task's LATEST
 * `contract_set` renders whole — every earlier superseded draft on that Task
 * renders as a 1-line `seq` header (re-contracted Tasks otherwise carry every
 * overwritten 8–13 KB brief verbatim) — and `report_written` paths are
 * deduplicated by resolved path before any file is read, so a respawned
 * Attempt's overwritten `report-<task>-<n>.md` rides the prompt at most once.
 *
 * Since v0.1.0 (ADR 0048 §4) an optional third parameter carries the bounded
 * Project notebook (`<projectStateDir>/notebook.md`, read via
 * `readProjectNotebook`); when non-empty it rides as the digest's last
 * section so already-hardened patterns are not re-proposed. Two-arg callers
 * get a byte-identical digest.
 */
export function buildRetroDigest(
  events: readonly LedgerEvent[],
  stateDir: string,
  options?: { notebook?: string },
): RetroCorpus {
  const knownSeqs = new Set(events.map((e) => e.seq));
  const taskOrder: string[] = [];
  const byTask = new Map<string, LedgerEvent[]>();
  const factoryLines: string[] = [];
  const reportEvents: Extract<LedgerEvent, { event: "report_written" }>[] = [];
  const seenReportPaths = new Set<string>();
  const attached = { logs: 0 };

  for (const evt of events) {
    if (evt.event === "ledger_schema") {
      factoryLines.push(`[${evt.seq}] ledger_schema version=${evt.version} ledger=${evt.ledger_id}`);
      continue;
    }
    if (evt.event === "retro_written") {
      // Prior Retros render as factory-level one-liners; their proposals
      // files are not re-fed (v1).
      factoryLines.push(
        evt.outcome === "written"
          ? `[${evt.seq}] retro_written written ${evt.proposalCount ?? 0} proposals → ${basename(evt.proposalsPath ?? "?")} (${evt.model}, ${evt.durationMs}ms)`
          : `[${evt.seq}] retro_written failed: ${evt.error ?? "(no reason recorded)"}`,
      );
      continue;
    }
    if (evt.event === "git_blocked" && evt.task === undefined) {
      // The shim refuses no matter who runs it; a block no live Contract
      // bound belongs to no task block — it still counts as corpus evidence.
      factoryLines.push(`[${evt.seq}] git_blocked rule=${evt.rule} — ${evt.reason} — ${stripped(evt.command)} cwd=${evt.cwd}`);
      continue;
    }
    if (typeof evt.task !== "string") continue;
    let block = byTask.get(evt.task);
    if (block === undefined) {
      block = [];
      byTask.set(evt.task, block);
      taskOrder.push(evt.task);
    }
    block.push(evt);
    // One Report per resolved path — a respawned Attempt rewrites the same
    // `report-<task>-<n>.md` and appends another `report_written` for it; the
    // dedup lands here, BEFORE any file is read from disk.
    if (evt.event === "report_written" && !seenReportPaths.has(evt.path)) {
      seenReportPaths.add(evt.path);
      reportEvents.push(evt);
    }
  }

  const sections: string[] = [];
  for (const task of taskOrder) {
    const block = byTask.get(task)!;
    const lines: string[] = [`## ${task}`];
    const allows = block.filter((e): e is Extract<LedgerEvent, { event: "permit_allowed" }> => e.event === "permit_allowed");
    // Only the Task's LATEST contract renders whole; earlier drafts on the
    // same Task are 1-line epoch markers (their `seq` stays citable).
    const latestContractSeq = block.findLast((e) => e.event === "contract_set")?.seq;
    for (const evt of block) {
      if (evt.event === "contract_set" && evt.seq !== latestContractSeq) {
        lines.push(`seq=${evt.seq} contract_set (superseded draft) gate=${evt.gate}`);
        continue;
      }
      lines.push(...renderTaskEvent(evt, stateDir, attached));
    }
    const parade = paradeLine(allows);
    if (parade !== undefined) lines.push(parade);
    sections.push(lines.join("\n"));
  }
  if (factoryLines.length > 0) sections.push(["## factory level", ...factoryLines].join("\n"));
  if (reportEvents.length > 0) {
    const reports: string[] = ["## reports"];
    for (const evt of reportEvents) {
      let content: string;
      try {
        content = readFileSync(evt.path, "utf8");
      } catch {
        content = "[report file unavailable]";
      }
      reports.push(`### ${basename(evt.path)}`, content);
    }
    sections.push(reports.join("\n"));
  }
  // The Project notebook rides LAST (v0.1.0, ADR 0048 §4) — after the bulk,
  // as context: what the Lead already hardened must not be re-proposed.
  if (options?.notebook !== undefined && options.notebook !== "") {
    sections.push(["## Project notebook (<projectStateDir>/notebook.md)", options.notebook].join("\n"));
  }

  const digest = [
    `# retro corpus — ${events.length} ledger events, ${taskOrder.length} task blocks, ${reportEvents.length} reports, ${attached.logs} red gate logs`,
    ...sections,
  ].join("\n\n");
  return {
    digest,
    eventsRead: events.length,
    taskBlocks: taskOrder.length,
    reports: reportEvents.length,
    redGateLogs: attached.logs,
    knownSeqs,
  };
}

/**
 * Every ledger seq that carries a non-empty `task` field, mapped to that Task
 * id (v0.1.0, ADR 0048 §4) — the retro's evidence cites `T-xx (seq N)`
 * citations, not bare numbers, so the Owner reads which Task recurred without
 * cross-referencing the digest.
 */
export function buildSeqToTaskMap(events: readonly LedgerEvent[]): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const evt of events) {
    // Factory-level kinds (ledger_schema, retro_written, …) carry no `task`;
    // the `in` check narrows to the members that can.
    if (!("task" in evt)) continue;
    const task = evt.task;
    if (typeof task === "string" && task !== "") map.set(evt.seq, task);
  }
  return map;
}

// ---- the prompt -------------------------------------------------------------------

/** The law the corpus already encodes — five fixed lines, the false-positive suppressor (ticket 03 item 4). */
const EXISTING_LAW = [
  "The choke's permit auto-allow is law: allowed asks are by design; only the deny-list fires.",
  "The watch is record-only: its lines never branch anything.",
  "Scope-mandatory spawn refusals (a parallel invocation whose task has no declared scope) are by design.",
  "Artifact existence is already gate law: green requires the artifact present.",
  "The fresh-eyes pass fires on green verdicts only, by design.",
];

/**
 * The Retro's prompt: read the whole corpus, propose only what it supports,
 * answer as exactly one strict JSON object. The EXISTING-LAW section rides
 * in so a pattern the factory already handles by design is never proposed as
 * a problem.
 */
export function buildRetroPrompt(digest: string): string {
  return [
    "You read the whole recorded history of a coding-agent factory — per-task digest blocks, factory-level lines, and every report — and you propose improvements.",
    "Repeated-error patterns become gate-check proposals (new mechanical checks a Gate command could run). Knowledge holes become contract-draft pieces (wording a future Contract could carry). Anything else worth the Owner's attention becomes an observation.",
    "",
    "Use ONLY the CORPUS material at the end of this prompt. Do not run commands; do not read or write files; everything you need is here.",
    "Cite ledger seq evidence for every proposal: the evidence array carries the seq numbers of the lines that ground it. A seq that does not exist in the corpus fails your whole output.",
    "Propose only what the corpus supports — the Recurrence Guard applies (ADR 0048): every proposal must cite at least 2 distinct seq numbers of a mechanism that RECURRED (one incident is never a rule), and you propose at most 2 proposals total — the 2 highest-impact. An empty proposals list is an honest answer when nothing recurred.",
    "Prefer Tier-1 mechanical fixes (a gate check, a .worktreeinclude entry, a script) and Tier-3 no-op rule deprecation (an already-violated prose rule upgraded to a mechanical check) over Tier-2 prose additions — encode lessons in structure, not paragraphs.",
    "The factory assigns proposal ids — never number them yourself.",
    "",
    "EXISTING LAW (already by design — do NOT propose these as problems or changes):",
    ...EXISTING_LAW.map((line) => `- ${line}`),
    "",
    "OUTPUT CONTRACT — strict:",
    'Answer with EXACTLY one JSON object, no other text before, between, or after (no markdown fences, no prose):',
    '{"proposals":[{"class":"gate-check|contract-draft|observation","evidence":[seq, …],"pattern":"the repeated pattern, named","text":"the proposal, concrete"}]}',
    "- class is exactly one of: gate-check, contract-draft, observation.",
    "- evidence is an array of at least 2 distinct integer seq numbers that exist in the corpus (the Recurrence Guard).",
    "- pattern and text are non-empty strings.",
    "Anything malformed fails the whole output.",
    "",
    "CORPUS:",
    digest,
  ].join("\n");
}

// ---- the strict parse --------------------------------------------------------------

/** One parsed Proposal — class ∈ the three, seq evidence, pattern, text; ids are the factory's act. */
export interface RetroProposal {
  cls: "gate-check" | "contract-draft" | "observation";
  evidence: number[];
  pattern: string;
  text: string;
  /**
   * The causal mechanism (v0.1.0, ADR 0048 §4) — 4-line ratification card
   * line 2 (`Nguyên nhân gốc`). Optional on the wire; falls back to `pattern`.
   */
  rootCause?: string;
  /**
   * The recurring effect (v0.1.0, ADR 0048 §4) — 4-line ratification card
   * line 1 (`Chuyện gì đã lặp lại`). Optional on the wire; falls back to `pattern`.
   */
  effect?: string;
}

/** The parse's verdict: every proposal read whole, or the named reason the output failed the contract. */
export type ParsedRetro = { ok: true; proposals: RetroProposal[] } | { ok: false; error: string };

const PROPOSAL_CLASSES = ["gate-check", "contract-draft", "observation"] as const;

/**
 * The Recurrence Guard's threshold (v0.1.0, ADR 0048 §4): a parsed proposal
 * must cite at least this many DISTINCT ledger seqs — one incident is never a
 * rule, so a single-seq (or single-seq-duplicated) proposal fails the parse.
 */
export const MIN_RETRO_EVIDENCE_SEQS = 2;

/**
 * The per-pass cap (v0.1.0, ADR 0048 §4): at most this many highest-impact
 * proposals ride out of the parse — the Owner ratifies in seconds, not
 * paragraphs. Every proposal is still validated whole before the cap.
 */
export const MAX_RETRO_PROPOSALS = 2;

/** The proposal's mandatory wire fields, in the strict parse's vocabulary. */
const REQUIRED_PROPOSAL_KEYS = ["class", "evidence", "pattern", "text"] as const;

/** The v0.1.0 optional companions (ADR 0048 §4) — accepted when present and non-empty. */
const OPTIONAL_PROPOSAL_KEYS = ["rootCause", "effect"] as const;

/**
 * Strips an enclosing Markdown code fence (` ```json … ``` ` or ` ``` … ``` `)
 * when the WHOLE output is fenced (v0.0.89, ADR 0045 §4) — LLM lanes wrap
 * their JSON despite the prompt's no-fence law, and a fenced-but-valid answer
 * must parse. The opening fence line (` ```json `, ` ``` `) and the closing
 * fence both go; anything not enclosed passes through untouched.
 */
function stripMarkdownFence(output: string): string {
  const fenced = output.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return fenced === null ? output : fenced[1]!;
}

/**
 * The strict output contract (ticket 03 item 4): `JSON.parse` plus a shape
 * check — the root object carries exactly `proposals`, each proposal exactly
 * class/evidence/pattern/text, every cited seq exists in the ledger.
 * Whole-parse, watch-grade: one bad proposal fails the whole output, never a
 * partial read. An empty list is legal — an honest nothing-proposed. The
 * parse tolerates an enclosing Markdown code fence around the JSON (v0.0.89,
 * ADR 0045 §4); everything else stays strict.
 *
 * The Recurrence Guard (v0.1.0, ADR 0048 §4): evidence deduplicates
 * (first-seen order) and a proposal must cite at least
 * `MIN_RETRO_EVIDENCE_SEQS` DISTINCT seqs — a single-incident proposal can
 * never pass — and the surviving proposals cap at `MAX_RETRO_PROPOSALS`
 * after every one was validated whole. The optional companions `rootCause` /
 * `effect` (the 4-line ratification card's fields) are accepted when present
 * and non-empty.
 */
export function parseRetroProposals(output: string, knownSeqs: ReadonlySet<number>): ParsedRetro {
  const bad = (error: string): ParsedRetro => ({ ok: false, error });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(output.trim()));
  } catch (err) {
    return bad(`output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bad("output is not a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== 1 || rootKeys[0] !== "proposals") {
    return bad(`root object must carry exactly "proposals", got: ${rootKeys.join(", ") || "(none)"}`);
  }
  if (!Array.isArray(root.proposals)) return bad('"proposals" is not an array');
  const proposals: RetroProposal[] = [];
  for (let i = 0; i < root.proposals.length; i += 1) {
    const item = root.proposals[i]!;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return bad(`proposal ${i + 1} is not an object`);
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    const rendered = [...keys].sort().join(",");
    if (
      keys.some((key) => !REQUIRED_PROPOSAL_KEYS.includes(key as (typeof REQUIRED_PROPOSAL_KEYS)[number]) && !OPTIONAL_PROPOSAL_KEYS.includes(key as (typeof OPTIONAL_PROPOSAL_KEYS)[number])) ||
      REQUIRED_PROPOSAL_KEYS.some((key) => !keys.includes(key))
    ) {
      return bad(`proposal ${i + 1} must carry exactly class/evidence/pattern/text (optional: rootCause, effect), got: ${rendered || "(none)"}`);
    }
    const cls = record.class;
    if (typeof cls !== "string" || !(PROPOSAL_CLASSES as readonly string[]).includes(cls)) {
      return bad(`proposal ${i + 1} class must be one of ${PROPOSAL_CLASSES.join(", ")}`);
    }
    const evidence = record.evidence;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return bad(`proposal ${i + 1} evidence must be a non-empty array of seq numbers`);
    }
    const seqs: number[] = [];
    for (const seq of evidence) {
      if (typeof seq !== "number" || !Number.isInteger(seq)) {
        return bad(`proposal ${i + 1} evidence carries a non-integer seq: ${JSON.stringify(seq)}`);
      }
      if (!knownSeqs.has(seq)) {
        return bad(`proposal ${i + 1} cites seq ${seq}, which does not exist in the ledger`);
      }
      // The Recurrence Guard counts DISTINCT seqs (v0.1.0, ADR 0048 §4):
      // duplicates collapse, first-seen order kept — [12, 12] counts once.
      if (!seqs.includes(seq)) seqs.push(seq);
    }
    if (seqs.length < MIN_RETRO_EVIDENCE_SEQS) {
      return bad(
        `proposal ${i + 1} evidence must cite at least ${MIN_RETRO_EVIDENCE_SEQS} distinct seq numbers (the Recurrence Guard — one incident is never a rule)`,
      );
    }
    if (typeof record.pattern !== "string" || record.pattern.trim() === "") {
      return bad(`proposal ${i + 1} pattern must be a non-empty string`);
    }
    if (typeof record.text !== "string" || record.text.trim() === "") {
      return bad(`proposal ${i + 1} text must be a non-empty string`);
    }
    for (const field of OPTIONAL_PROPOSAL_KEYS) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") {
        return bad(`proposal ${i + 1} ${field} must be a non-empty string when present`);
      }
    }
    const rootCause = typeof record.rootCause === "string" ? record.rootCause : undefined;
    const effect = typeof record.effect === "string" ? record.effect : undefined;
    proposals.push({
      cls: cls as RetroProposal["cls"],
      evidence: seqs,
      pattern: record.pattern,
      text: record.text,
      ...(rootCause === undefined ? {} : { rootCause }),
      ...(effect === undefined ? {} : { effect }),
    });
  }
  // Whole-parse first, cap last (v0.1.0, ADR 0048 §4): every proposal was
  // validated above — one bad one already failed the output — so the cap only
  // trims how many ride out, never what was checked.
  return { ok: true, proposals: proposals.slice(0, MAX_RETRO_PROPOSALS) };
}

// ---- the proposals file ------------------------------------------------------------

/** The UTC day of a Date, `YYYY-MM-DD` — the file name, the ledger ts day, and the same-day rule all key on it. */
export function retroDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** `retro-<YYYY-MM-DD>.md` — one proposals file per UTC day, in the stateDir beside the reports. */
export function retroFilePath(stateDir: string, day: string): string {
  return join(stateDir, `retro-${day}.md`);
}

/**
 * Orders proposals into ratification reading order — gate-check first, then
 * contract-draft, then observation — and assigns the factory's R1…Rn ids in
 * that order (the model never numbers its own).
 */
export function orderForRatification(proposals: readonly RetroProposal[]): { id: number; proposal: RetroProposal }[] {
  const rank = (cls: RetroProposal["cls"]): number => (cls === "gate-check" ? 0 : cls === "contract-draft" ? 1 : 2);
  return [...proposals]
    .map((proposal, index) => ({ proposal, index }))
    .sort((a, b) => rank(a.proposal.cls) - rank(b.proposal.cls) || a.index - b.index)
    .map(({ proposal }, i) => ({ id: i + 1, proposal }));
}

/**
 * One seq's citation (v0.1.0, ADR 0048 §4): `T-xx (seq N)` when the map
 * resolves the seq to its Task, else the bare `seq N`.
 */
function citation(seq: number, seqToTask?: ReadonlyMap<number, string>): string {
  const task = seqToTask?.get(seq);
  return task === undefined ? `seq ${seq}` : `${task} (seq ${seq})`;
}

/** The proposal's evidence as a citation list — `T-01 (seq 3), T-02 (seq 5), seq 7`. */
function citations(evidence: readonly number[], seqToTask?: ReadonlyMap<number, string>): string {
  return evidence.map((seq) => citation(seq, seqToTask)).join(", ");
}

/**
 * Renders `retro-<date>.md` (ticket 03 item 6): header with date, model and
 * the corpus facts, then the body grouped by class in ratification reading
 * order, each proposal `## R1 — gate-check` with Evidence, Pattern, Proposal.
 * Since v0.1.0 (ADR 0048 §4) each proposal also carries the 4-Line Owner
 * Ratification card — `1. Chuyện gì đã lặp lại` (the recurring effect, with
 * the Task-resolved citations) → `2. Nguyên nhân gốc` (the causal mechanism)
 * → `3. Nếu duyệt sẽ sửa gì (Preview diff)` (the proposal) → `4. Tác dụng`
 * (the recurrence ratifying ends — the ADR's "class of failure prevented in
 * future waves", so line 4 never repeats line 3 verbatim) —
 * so the Owner can ratify or reject in 10 seconds. The Evidence line cites
 * `T-xx (seq N)` via `seqToTask`, falling back to `seq N` for unmapped seqs;
 * the header/`- Proposal:` shapes the ratification path parses are unchanged.
 */
export function renderRetroFile(input: {
  day: string;
  model: string;
  durationMs: number;
  corpus: RetroCorpus;
  proposals: readonly RetroProposal[];
  /** seq → Task id (v0.1.0, ADR 0048 §4) — built by `buildSeqToTaskMap`; omitted, evidence cites bare `seq N`. */
  seqToTask?: ReadonlyMap<number, string>;
}): string {
  const ordered = orderForRatification(input.proposals);
  const header = [
    `# Retro ${input.day} — ${ordered.length} proposal${ordered.length === 1 ? "" : "s"}`,
    "",
    `- Model: ${input.model}`,
    `- Corpus: ${input.corpus.eventsRead} ledger events · ${input.corpus.taskBlocks} task blocks · ${input.corpus.reports} reports · ${input.corpus.redGateLogs} red gate logs`,
    `- Duration: ${input.durationMs}ms`,
    "- Advice for the Owner. Nothing here is law until ratified — the factory never applies its own proposals.",
  ];
  if (ordered.length === 0) {
    return `${[...header, "", "(the model proposed nothing — an honest empty read of the corpus)"].join("\n")}\n`;
  }
  const body = ordered.map(({ id, proposal }) => {
    const cited = citations(proposal.evidence, input.seqToTask);
    return [
      `## R${id} — ${proposal.cls}`,
      `- Evidence (ledger seq): ${cited}`,
      `- Pattern: ${proposal.pattern}`,
      `- Proposal: ${proposal.text}`,
      `1. Chuyện gì đã lặp lại: ${proposal.effect ?? proposal.pattern} (evidence: ${cited})`,
      `2. Nguyên nhân gốc: ${proposal.rootCause ?? proposal.pattern}`,
      `3. Nếu duyệt sẽ sửa gì (Preview diff): ${proposal.text}`,
      `4. Tác dụng: ends the recurrence — ${proposal.effect ?? proposal.pattern}`,
    ].join("\n");
  });
  return `${[...header, "", ...body].join("\n\n")}\n`;
}

// ---- the pass ----------------------------------------------------------------------

/** What one Retro pass measured, in the shape of the `retro_written` payload. */
export type RetroOutcome = Omit<RetroWritten, "seq" | "ts" | "event">;

/**
 * What one pass needs: where the proposals file lands (the stateDir — the
 * retro lane reads from `<stateDir>/lanes.json`, or the Project's own
 * override when `projectSlug` scopes the pass), the corpus to prompt with,
 * and the two test seams the watch also carries — the budget override and
 * the fake CLI runner.
 */
export interface RetroPassInput {
  stateDir: string;
  /**
   * Where the proposals file lands when the factory is project-scoped
   * (v0.0.14, ADR 0010 §5) — `<stateDir>/projects/<slug>/`. The lane still
   * reads machine config from `stateDir`; omitted, the file lands beside the
   * root ledger (the legacy layout).
   */
  dataDir?: string;
  corpus: RetroCorpus;
  /**
   * seq → Task id map (v0.1.0, ADR 0048 §4) — built by `buildSeqToTaskMap`;
   * the rendered file cites evidence as `T-xx (seq N)` when given, bare
   * `seq N` otherwise.
   */
  seqToTask?: ReadonlyMap<number, string>;
  /** Total budget override covering both tries (tests); default RETRO_TOTAL_BUDGET_MS. */
  budgetMs?: number;
  /** Lane CLI runner override (tests) — the lane and its tool-less flags stay fixed regardless. */
  copilotRunner?: CopilotRunner;
  /**
   * The Project scope (v0.0.38, ADR 0026 §1) — the per-Project lanes.json
   * override the pass honors; the trailing parameter with the same name
   * wins when both are given. The retro has no Contract to auto-resolve
   * from, so an omitted scope keeps the machine-wide lane.
   */
  projectSlug?: string;
}

/**
 * One Retro pass: prompt the retro lane with the whole corpus, strict-parse
 * the JSON proposals, write the proposals file. Never throws — every death
 * is a returned `failed` outcome so the ledger line stays visible. The lane
 * runner's machinery runs unchanged (scratch cwd, prompt on stdin, SIGKILL
 * at the deadline, stderr squash) under two deliberate divergences (ticket
 * 03 item 5+7): the budget is 10 minutes, and parse failures retry once too
 * — a multi-minute generation dying on one malformed brace must not cost the
 * Owner a whole re-run. The lane resolves per Project when a scope is given
 * (v0.0.38, ADR 0026 §1).
 */
export async function runRetroPass(input: RetroPassInput, projectSlug?: string): Promise<RetroOutcome> {
  const started = Date.now();
  const scopeParam = (projectSlug ?? input.projectSlug)?.trim();
  const scope = scopeParam === undefined || scopeParam === "" ? undefined : scopeParam;
  const lanes = loadLanes(input.stateDir, scope);
  const lane = lanes.ok ? lanes.lanes.retro : undefined;
  const failed = (error: string): RetroOutcome => ({
    model: lane ?? "unconfigured",
    outcome: "failed",
    durationMs: Date.now() - started,
    error,
  });

  if (!lanes.ok) return failed(`retro lane unusable: ${lanes.reason}`);

  const prompt = buildRetroPrompt(input.corpus.digest);
  const budgetMs = input.budgetMs ?? RETRO_TOTAL_BUDGET_MS;

  let lastError = "the lane CLI never ran";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return failed(`retro budget of ${budgetMs}ms exceeded`);
    const result = await runLaneCli({
      lane: lane!,
      stdin: prompt,
      timeoutMs: remaining,
      runner: input.copilotRunner,
      stateDir: input.stateDir,
    });
    if (result.ok) {
      const parsed = parseRetroProposals(result.stdout, input.corpus.knownSeqs);
      if (parsed.ok) {
        // The file lands BEFORE any ledger line exists for this pass (ticket
        // 03 item 3): a death between leaves an orphan file that never
        // happened; a line without a file cannot occur.
        const day = retroDay(new Date());
        const path = retroFilePath(input.dataDir ?? input.stateDir, day);
        writeFileSync(path, renderRetroFile({ day, model: lane!, durationMs: Date.now() - started, corpus: input.corpus, proposals: parsed.proposals, seqToTask: input.seqToTask }));
        return {
          model: lane!,
          outcome: "written",
          durationMs: Date.now() - started,
          proposalsPath: path,
          proposalCount: parsed.proposals.length,
        };
      }
      lastError = `parse failed: ${parsed.error}`;
      continue; // divergence 2 — a parse failure retries once inside the same clock
    }
    if (result.budgetExceeded) return failed(`retro budget of ${budgetMs}ms exceeded`); // the clock is spent — no second try
    lastError = result.error;
  }
  return failed(lastError);
}

/**
 * The same-day rule's read: the last `retro_written` whose outcome is
 * `written` and whose ledger day is `day`, when one exists. A failed Retro
 * writes no file, so a same-day retry after failure stays legal.
 */
export function writtenRetroForDay(events: readonly LedgerEvent[], day: string): RetroWritten | undefined {
  let found: RetroWritten | undefined;
  for (const evt of events) {
    if (evt.event === "retro_written" && evt.outcome === "written" && evt.ts.slice(0, 10) === day) found = evt;
  }
  return found;
}
