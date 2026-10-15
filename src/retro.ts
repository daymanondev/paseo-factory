/**
 * The Retro (v0.0.7, tickets 01–04): the on-demand, Owner-invoked pass over
 * the whole recorded history. The plugin builds the ledger into a per-task
 * digest (contracts whole, attempt lifecycles, every denial/block/refusal,
 * the permit parade rolled to one count-line per task), attaches all reports
 * whole and the red Attempts' gate logs, prompts the `retro` lane headless
 * and tool-less — since v0.0.13 (ADR 0009 §3) that lane lives in
 * `<stateDir>/lanes.json` (default `pi/zai/glm-5.3`), any CLI family, the
 * shared lane runner — and strict-parses one JSON object of proposals out of
 * the response. Every Proposal cites ledger seq evidence; the factory
 * assigns R1…Rn ids; the pass writes `retro-<date>.md` in the stateDir
 * first, then exactly one `retro_written` ledger line (the first
 * factory-level event) lands — file before line, so a death between leaves
 * an orphan file that never happened and a line without a file cannot
 * occur. Nothing downstream branches on the proposals: the factory proposes,
 * only the Owner ratifies.
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
 * overrides the real version probe (tests) and receives the lane.
 */
export function retroLaneAvailable(
  stateDir: string,
  probe?: (lane: string) => boolean,
): { ok: true; lane: string } | { ok: false; reason: string } {
  const lanes = loadLanes(stateDir);
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
 */
export function buildRetroDigest(events: readonly LedgerEvent[], stateDir: string): RetroCorpus {
  const knownSeqs = new Set(events.map((e) => e.seq));
  const taskOrder: string[] = [];
  const byTask = new Map<string, LedgerEvent[]>();
  const factoryLines: string[] = [];
  const reportEvents: Extract<LedgerEvent, { event: "report_written" }>[] = [];
  const attached = { logs: 0 };

  for (const evt of events) {
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
    if (evt.event === "report_written") reportEvents.push(evt);
  }

  const sections: string[] = [];
  for (const task of taskOrder) {
    const block = byTask.get(task)!;
    const lines: string[] = [`## ${task}`];
    const allows = block.filter((e): e is Extract<LedgerEvent, { event: "permit_allowed" }> => e.event === "permit_allowed");
    for (const evt of block) lines.push(...renderTaskEvent(evt, stateDir, attached));
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
    "Propose only what the corpus supports — strongest only, quality over quantity, no count cap. An empty proposals list is an honest answer when nothing is supported.",
    "The factory assigns proposal ids — never number them yourself.",
    "",
    "EXISTING LAW (already by design — do NOT propose these as problems or changes):",
    ...EXISTING_LAW.map((line) => `- ${line}`),
    "",
    "OUTPUT CONTRACT — strict:",
    'Answer with EXACTLY one JSON object, no other text before, between, or after (no markdown fences, no prose):',
    '{"proposals":[{"class":"gate-check|contract-draft|observation","evidence":[seq, …],"pattern":"the repeated pattern, named","text":"the proposal, concrete"}]}',
    "- class is exactly one of: gate-check, contract-draft, observation.",
    "- evidence is a non-empty array of integer seq numbers that exist in the corpus.",
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
}

/** The parse's verdict: every proposal read whole, or the named reason the output failed the contract. */
export type ParsedRetro = { ok: true; proposals: RetroProposal[] } | { ok: false; error: string };

const PROPOSAL_CLASSES = ["gate-check", "contract-draft", "observation"] as const;

/**
 * The strict output contract (ticket 03 item 4): `JSON.parse` plus a shape
 * check — the root object carries exactly `proposals`, each proposal exactly
 * class/evidence/pattern/text, every cited seq exists in the ledger.
 * Whole-parse, watch-grade: one bad proposal fails the whole output, never a
 * partial read. An empty list is legal — an honest nothing-proposed.
 */
export function parseRetroProposals(output: string, knownSeqs: ReadonlySet<number>): ParsedRetro {
  const bad = (error: string): ParsedRetro => ({ ok: false, error });
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
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
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "class,evidence,pattern,text") {
      return bad(`proposal ${i + 1} must carry exactly class/evidence/pattern/text, got: ${keys || "(none)"}`);
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
      seqs.push(seq);
    }
    if (typeof record.pattern !== "string" || record.pattern.trim() === "") {
      return bad(`proposal ${i + 1} pattern must be a non-empty string`);
    }
    if (typeof record.text !== "string" || record.text.trim() === "") {
      return bad(`proposal ${i + 1} text must be a non-empty string`);
    }
    proposals.push({ cls: cls as RetroProposal["cls"], evidence: seqs, pattern: record.pattern, text: record.text });
  }
  return { ok: true, proposals };
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
 * Renders `retro-<date>.md` (ticket 03 item 6): header with date, model and
 * the corpus facts, then the body grouped by class in ratification reading
 * order, each proposal `## R1 — gate-check` with Evidence, Pattern, Proposal.
 */
export function renderRetroFile(input: {
  day: string;
  model: string;
  durationMs: number;
  corpus: RetroCorpus;
  proposals: readonly RetroProposal[];
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
  const body = ordered.map(({ id, proposal }) =>
    [
      `## R${id} — ${proposal.cls}`,
      `- Evidence (ledger seq): ${proposal.evidence.join(", ")}`,
      `- Pattern: ${proposal.pattern}`,
      `- Proposal: ${proposal.text}`,
    ].join("\n"),
  );
  return `${[...header, "", ...body].join("\n\n")}\n`;
}

// ---- the pass ----------------------------------------------------------------------

/** What one Retro pass measured, in the shape of the `retro_written` payload. */
export type RetroOutcome = Omit<RetroWritten, "seq" | "ts" | "event">;

/**
 * What one pass needs: where the proposals file lands (the stateDir — the
 * retro lane reads from `<stateDir>/lanes.json`), the corpus to prompt with,
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
  /** Total budget override covering both tries (tests); default RETRO_TOTAL_BUDGET_MS. */
  budgetMs?: number;
  /** Lane CLI runner override (tests) — the lane and its tool-less flags stay fixed regardless. */
  copilotRunner?: CopilotRunner;
}

/**
 * One Retro pass: prompt the retro lane with the whole corpus, strict-parse
 * the JSON proposals, write the proposals file. Never throws — every death
 * is a returned `failed` outcome so the ledger line stays visible. The lane
 * runner's machinery runs unchanged (scratch cwd, prompt on stdin, SIGKILL
 * at the deadline, stderr squash) under two deliberate divergences (ticket
 * 03 item 5+7): the budget is 10 minutes, and parse failures retry once too
 * — a multi-minute generation dying on one malformed brace must not cost the
 * Owner a whole re-run.
 */
export async function runRetroPass(input: RetroPassInput): Promise<RetroOutcome> {
  const started = Date.now();
  const lanes = loadLanes(input.stateDir);
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
    });
    if (result.ok) {
      const parsed = parseRetroProposals(result.stdout, input.corpus.knownSeqs);
      if (parsed.ok) {
        // The file lands BEFORE any ledger line exists for this pass (ticket
        // 03 item 3): a death between leaves an orphan file that never
        // happened; a line without a file cannot occur.
        const day = retroDay(new Date());
        const path = retroFilePath(input.dataDir ?? input.stateDir, day);
        writeFileSync(path, renderRetroFile({ day, model: lane!, durationMs: Date.now() - started, corpus: input.corpus, proposals: parsed.proposals }));
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
