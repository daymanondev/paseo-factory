import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { buildSeatKickoffPacket } from "../src/preflight.ts";
import { projectNotebookPath } from "../src/project.ts";
import { formatScrumRunDigest } from "../src/scrum/run-digest.ts";
import { renderScrumPrompt, SCRUM_LEAD_MCP_TOOLS, SCRUM_SUPERVISOR_MCP_TOOLS } from "../src/scrum/prompts.ts";
import { OPEN_DESIGN_CONTRACT } from "../src/scrum/open-design.ts";
import type { ScrumRun } from "../src/scrum/run-journal.ts";
import type { ArtifactRef } from "../src/scrum/types.ts";
import { LEAD_WAVE_LAWS, SUPERVISOR_OUTCOME_BOUNDARY } from "../src/roles-contract.ts";
import type { LedgerEvent } from "../src/events.ts";

test("kickoff and Scrum prompts report present and absent project memory", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const input = { role: "lead" as const, projectSlug: "empty", projectRoot: root, ledgerEvents: [] };
  assert.match(buildSeatKickoffPacket(input), /Project memory: none present on disk/);
  writeFileSync(join(root, "AGENTS.md"), "rules");
  const packet = buildSeatKickoffPacket(input);
  assert.match(packet, /read before acting: AGENTS.md/);
  assert.match(packet, /CLAUDE.md \(absent — do not call read_file\)/);
  assert.match(packet, /CONTEXT.md \(absent — do not call read_file\)/);
  for (const role of ["supervisor", "lead", "pm", "ux", "architect", "dev", "qa"] as const) {
    const prompt = renderScrumPrompt(role, { project: "empty", workspace: root });
    assert.match(prompt, /read before acting: AGENTS.md/);
    assert.doesNotMatch(prompt, /Use factory scrum|factory contract/);
    if (role === "lead") assert.match(prompt, /lead_scrum_operation/);
    if (role === "supervisor") assert.match(prompt, /supervisor_scrum_decision/);
  }
});

test("Lead kickoff describes Peer helpers and warns before dispatch with missing credentials", async (t) => {
  const { buildRoleKickoffPrompt } = await import("../src/roles-contract.ts");
  const dir = makeTempDir(); disposeDir(t, dir);
  const helperMcps = [{ name: "supabase", transport: "http" as const, status: "auth_expired" as const, enabled: true }];
  const packet = buildSeatKickoffPacket({ role: "lead", projectSlug: "repo", projectRoot: dir, ledgerEvents: [], helperMcps });
  assert.match(packet, /Available Peer Helper MCPs/);
  assert.match(packet, /supabase \[http · auth_expired\]/);
  assert.match(packet, /WARNING/);
  for (const role of ["lead", "agent"] as const) assert.match(buildRoleKickoffPrompt(role, { helperMcps }), /supabase \[http · auth_expired\]/);
});

test('linked Owner designs are authoritative in seat kickoff and Scrum UX prompts', async t => {
  const root = makeTempDir(); disposeDir(t, root); mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify({ projectId: 'owner', projectName: 'Checkout flow', sourceUpdatedAt: 1, syncedAt: '2026-11-02', screenCount: 4, files: [], digest: 'abc' }));
  for (const role of ['lead', 'supervisor'] as const) {
    const packet = buildSeatKickoffPacket({ role, projectSlug: 'repo', projectRoot: root, ledgerEvents: [] });
    assert.match(packet, /Open Design Linked Specification/); assert.match(packet, /Checkout flow/);
    assert.match(packet, /design\/screens.html/); assert.match(packet, /4 screens/); assert.match(packet, /authoritative/);
    // v0.0.84: the clause splits the bundle — catalog is the only design/ read.
    assert.match(packet, /Design catalog \(the ONLY design\/ files a Lead reads\)/);
    assert.match(packet, /design\/design-manifest\.json/); assert.match(packet, /design\/screens-data\.js/); assert.match(packet, /design\/app-data\.js/);
    assert.match(packet, /Design source \(a Lead NEVER reads/);
    assert.match(packet, /decomposition input, not a build spec/);
  }
  assert.match(renderScrumPrompt('ux', { project: 'repo', workspace: root }), /preserve and refine the Owner's linked Open Design screens/);
});

test('kickoff packet drops only the system-prompt duplicates when omitSystemPromptDuplicates is set (ADR 0047)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify({ projectId: 'owner', projectName: 'Checkout flow', sourceUpdatedAt: 1, syncedAt: '2026-11-02', screenCount: 4, files: [], digest: 'abc' }));
  const helperMcps = [{ name: "supabase", transport: "http" as const, status: "auth_expired" as const, enabled: true }];
  const lawLineCount = (packet: string): number => packet.split('\n').filter(line => line.startsWith('- Law: ')).length;

  for (const role of ['lead', 'supervisor'] as const) {
    const base = { role, projectSlug: 'repo', projectRoot: root, ledgerEvents: [], helperMcps };
    // Default stays complete and self-contained (User Story 4) — omitting the
    // flag and passing false are byte-for-byte identical.
    const full = buildSeatKickoffPacket(base);
    assert.equal(buildSeatKickoffPacket({ ...base, omitSystemPromptDuplicates: false }), full);
    assert.match(full, /Open Design Linked Specification/);
    if (role === 'lead') {
      assert.match(full, /Available Peer Helper MCPs/);
      for (const law of LEAD_WAVE_LAWS) assert.ok(full.includes(`- Law: ${law}`), `missing wave law: ${law.slice(0, 40)}`);
      assert.equal(lawLineCount(full), LEAD_WAVE_LAWS.length + 1);
    } else {
      assert.ok(full.includes(`- Law: ${SUPERVISOR_OUTCOME_BOUNDARY}`));
      assert.equal(lawLineCount(full), 2);
    }

    // The deduplicated packet drops exactly the three static blocks already
    // carried by config.systemPrompt…
    const lean = buildSeatKickoffPacket({ ...base, omitSystemPromptDuplicates: true });
    assert.doesNotMatch(lean, /Open Design Linked Specification/);
    assert.doesNotMatch(lean, /Available Peer Helper MCPs/);
    for (const law of LEAD_WAVE_LAWS) assert.ok(!lean.includes(law), `wave law leaked into the omit packet: ${law.slice(0, 40)}`);
    assert.ok(!lean.includes(SUPERVISOR_OUTCOME_BOUNDARY));
    assert.equal(lawLineCount(lean), 1);
    // …while every dynamic preflight line and the Fire-and-End-Turn law stay.
    assert.match(lean, new RegExp(`^- Workspace: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(lean, /- Git: branch=`.*`, head=`.*`, status=clean/);
    assert.match(lean, /- Top-level files: design/);
    assert.match(lean, /- Memory\/docs present: /);
    assert.match(lean, /Project memory: none present on disk/);
    assert.match(lean, /- Build\/Test commands: /);
    assert.match(lean, /- Active lanes: default/);
    assert.match(lean, /- Ledger tasks: none \(clean slate\)/);
    assert.match(lean, /- Role MCP tools \(paseo_factory\): /);
    assert.match(lean, /- Law: Fire-and-End-Turn: /);
    assert.match(lean, /--- \[paseo-factory seat kickoff packet · role=/);
    assert.match(lean, /--- \[end seat kickoff packet\] ---/);
    // Nothing new appears in the omit packet: every line of the lean packet
    // is a line of the full packet, so only the static blocks were removed.
    const fullLines = new Set(full.split('\n'));
    for (const line of lean.split('\n')) {
      assert.ok(fullLines.has(line), `line only in the omit packet: ${JSON.stringify(line)}`);
    }
  }
});

test('kickoff packet injects the Project notebook path and content for Lead and Supervisor seats, with the clean empty-state placeholder when the notebook is absent (v0.1.0, ADR 0048 §3)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  const stateDir = makeTempDir(); disposeDir(t, stateDir);
  const notebookDir = join(stateDir, "projects", "repo");
  mkdirSync(notebookDir, { recursive: true });
  const notebookPath = projectNotebookPath(stateDir, "repo");
  const packetLines = (packet: string): Set<string> => new Set(packet.split("\n"));

  // stateDir omitted (standalone callers): no notebook lines at all — the
  // packet stays byte-for-byte backward-compatible.
  for (const role of ["supervisor", "lead"] as const) {
    const bare = buildSeatKickoffPacket({ role, projectSlug: "repo", projectRoot: root, ledgerEvents: [] });
    assert.ok(!bare.includes("Project notebook"), `${role} packet must carry no notebook lines without stateDir`);
  }

  // stateDir provided, notebook absent: the exact path plus the clean
  // empty-state placeholder telling the seat when to initialize it.
  for (const role of ["supervisor", "lead"] as const) {
    const empty = buildSeatKickoffPacket({ role, projectSlug: "repo", projectRoot: root, ledgerEvents: [], stateDir });
    const lines = packetLines(empty);
    assert.ok(lines.has(`- Project notebook path: ${notebookPath}`), `${role} packet carries the slug-dependent notebook path`);
    assert.ok(
      lines.has(`- Project notebook (${notebookPath}): (none yet — initialize on first verified Gate or observed failure mechanism)`),
      `${role} packet carries the empty-state placeholder`,
    );
  }

  // stateDir provided, notebook present: the bounded content rides the packet,
  // and the block survives omitSystemPromptDuplicates (dynamic state, not a
  // static law) so Turn-1 seats see it even when the packet is deduplicated.
  const content = [
    "## 1. Verification & Run Recipe",
    "- Gate: npm test (cold cache first)",
    "",
    "## 2. Recurrence Guard",
    "- [observed 1x] flaky gate on cold cache — Task (seq 3)",
  ].join("\n");
  writeFileSync(join(notebookDir, "notebook.md"), content);
  for (const role of ["supervisor", "lead"] as const) {
    const packet = buildSeatKickoffPacket({ role, projectSlug: "repo", projectRoot: root, ledgerEvents: [], stateDir });
    const lines = packetLines(packet);
    assert.ok(lines.has(`- Project notebook path: ${notebookPath}`));
    assert.ok(lines.has(`- Project notebook (${notebookPath}):`), `${role} packet carries the notebook header`);
    for (const line of content.split("\n")) {
      assert.ok(lines.has(line), `${role} packet missing notebook line: ${JSON.stringify(line)}`);
    }
    const lean = buildSeatKickoffPacket({ role, projectSlug: "repo", projectRoot: root, ledgerEvents: [], stateDir, omitSystemPromptDuplicates: true });
    const leanLines = packetLines(lean);
    assert.ok(leanLines.has(`- Project notebook path: ${notebookPath}`), "notebook path survives omitSystemPromptDuplicates");
    assert.ok(leanLines.has("## 1. Verification & Run Recipe"), "notebook content survives omitSystemPromptDuplicates");
  }
});

test('Ledger tasks line compacts more than three accepted tasks into a count + latest tail (ADR 0047)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  const ledgerRows = (tasks: Array<{ task: string; stage: 'contracted' | 'green' | 'accepted' }>): LedgerEvent[] => {
    const events: LedgerEvent[] = [];
    let seq = 1;
    for (const { task, stage } of tasks) {
      events.push({ seq: seq++, ts: '2026-11-05T00:00:00Z', event: 'contract_set', task, workspace: root, gate: 'npm test', artifact: `report-${task}.md` });
      if (stage !== 'contracted') {
        events.push({ seq: seq++, ts: '2026-11-05T00:00:00Z', event: 'gate_finished', task, attempt: 1, exit: 0, verdict: 'green', note: 'gate passed' });
      }
      if (stage === 'accepted') {
        events.push({ seq: seq++, ts: '2026-11-05T00:00:00Z', event: 'attempt_accepted', task, attempt: 1 });
      }
    }
    return events;
  };
  const ledgerLine = (events: LedgerEvent[]): string =>
    buildSeatKickoffPacket({ role: 'lead', projectSlug: 'repo', projectRoot: root, ledgerEvents: events }).split('\n')
      .find(line => line.startsWith('- Ledger tasks: ')) ?? '(ledger line missing)';

  // > 3 accepted: closed tasks collapse into one count + latest-3 prefix;
  // unaccepted tasks keep their full [status, attempts, verdict] entry.
  const crowded = ledgerRows([
    { task: 'T-01', stage: 'accepted' },
    { task: 'T-02', stage: 'accepted' },
    { task: 'T-03', stage: 'accepted' },
    { task: 'T-04', stage: 'accepted' },
    { task: 'T-05', stage: 'accepted' },
    { task: 'T-06', stage: 'green' },
    { task: 'T-07', stage: 'contracted' },
  ]);
  assert.equal(
    ledgerLine(crowded),
    '- Ledger tasks: 5 accepted (latest: T-03, T-04, T-05); T-06 [green, attempts=1, verdict=green]; T-07 [contracted, attempts=0, verdict=none]',
  );

  // <= 3 accepted: today's per-task rendering is preserved for every row.
  const small = ledgerRows([{ task: 'T-01', stage: 'accepted' }, { task: 'T-02', stage: 'accepted' }, { task: 'T-03', stage: 'green' }]);
  assert.equal(
    ledgerLine(small),
    '- Ledger tasks: T-01 [accepted (by owner), attempts=1, verdict=green]; T-02 [accepted (by owner), attempts=1, verdict=green]; T-03 [green, attempts=1, verdict=green]',
  );
});

const digestRef = (path: string): ArtifactRef => ({
  path,
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

const completeResult = (path: string): NonNullable<ScrumRun["tasks"][number]["result"]> => ({
  status: "complete",
  artifactRefs: [digestRef(path)],
  assumptions: [],
  openQuestions: [],
  conflicts: [],
});

/** v0.2.0 digest fixture: 6 tasks, 4 settled (complete) + 2 active/unaccepted, with every QA/fix/owner/wakeup shape populated. */
const digestFixtureRun = (): ScrumRun => ({
  mode: "scrum",
  runId: "r1",
  initiativeId: "feature-x",
  policyRevision: "0040-r1",
  configRevision: 1,
  config: {
    schemaVersion: 1,
    requireUiApproval: true,
    lanes: {
      supervisor: "zcode/gl-5.3", lead: "zcode/gl-5.3", pm: "zcode/gl-5.3",
      ux: "zcode/gl-5.1", architect: "zcode/gl-5.3", dev: "zcode/gl-5.1",
      qa: "zcode/gl-5-turbo", watch: "zcode/gl-5-turbo", retro: "zcode/gl-5-turbo",
    },
  },
  track: "small",
  rationale: "bounded checkout repair",
  budgets: { maxTasks: 12, maxQaFixRounds: 2 },
  revision: 7,
  createdAt: "2026-11-06T00:00:00.000Z",
  phase: "implementation",
  fixRounds: 1,
  fixReservations: [{ task: "fix-1", requestId: "fr-1", summary: "repair crash on checkout submit" }],
  tasks: [
    { task: "T-01", role: "pm", required: true, result: completeResult("docs/prd.md") },
    { task: "T-02", role: "ux", required: true, result: completeResult("docs/ux-spec.md") },
    { task: "T-03", role: "architect", required: true, result: completeResult("docs/architecture.md") },
    { task: "T-04", role: "dev", required: true, result: completeResult("src/checkout.ts") },
    { task: "T-05", role: "dev", required: true, epoch: 2, contractIntents: [{ requestId: "ci-1", fingerprint: "fp-1", epoch: 2 }] },
    { task: "T-06", role: "qa", required: true, result: { ...completeResult("qa/q1/bundle"), status: "partial" } },
  ],
  ownedPaths: [],
  artifacts: [],
  blockers: ["budget-exhaustion"],
  blockerDetails: [{ id: "b1", reason: "qa fix rounds exhausted", causes: ["qaFixRounds"] }],
  qaAudits: [digestRef("qa/audit-1/qa-report.json"), digestRef("qa/audit-2/qa-report.json")],
  promotions: [],
  decisions: 3,
  readiness: {
    refs: [digestRef("docs/readiness.md")],
    contradictions: ["auth ownership conflict between pm and architect"],
    unsafeAssumptions: [],
    missingCoverage: ["offline queue coverage"],
    rationale: "readiness recorded with one open contradiction",
  },
  design: {
    revision: 2,
    digest: "d41d8cd98f00b204e9800998ecf8427e",
    refs: [],
    browserEvidence: [],
    decision: "approved",
    screenStatuses: { checkout: "approved", cart: "revise" },
  },
  ownerRequests: [
    {
      id: "q1",
      kind: "question",
      question: "Should the offline queue persist across restarts?",
      affected: [{ kind: "task", id: "T-05" }],
      origin: { actor: "lead", role: "lead" },
      status: "pending",
      createdAt: "2026-11-06T01:00:00.000Z",
    },
    {
      id: "q2",
      kind: "question",
      question: "already answered question",
      affected: [{ kind: "stage", id: "qa" }],
      origin: { actor: "lead", role: "lead" },
      status: "answered",
      createdAt: "2026-11-06T02:00:00.000Z",
      resolution: { actor: "owner", outcome: "answer", rationale: "done", requestId: "q2" },
    },
  ],
  wakeups: [
    { id: "w1", message: "Owner answered q1 — resume fixing", target: "lead" },
    { id: "w2", message: "already delivered", target: "lead", delivered: true },
  ],
  operationIntents: [{ operationId: "op-1", fingerprint: "fp-1", payload: { secret: "do-not-dump-operation-intents" } }],
});

test('formatScrumRunDigest renders a bounded compact digest: full active rows, settled compaction, QA/fix/owner/wakeup state, and never raw run JSON (v0.2.0, ADR 0049 §2)', t => {
  const run = digestFixtureRun();
  const digest = formatScrumRunDigest(run);
  const lines = new Set(digest.split("\n"));
  // Header line: run identity, phase, track + rationale, revisions, and both budget ratios.
  assert.ok(
    lines.has(
      "Scrum run r1 (initiative feature-x): phase=implementation, track=small (bounded checkout repair), revision=7, configRevision=1, budgets: tasks=6/12, qaFixRounds=1/2",
    ),
    "header line with identity, phase, track rationale, revisions, and budget ratios",
  );
  // Readiness from the real shape (no verdict field): presence + rationale +
  // contradiction/unsafe-assumption/missing-coverage counts; blockers from run.blockers/blockerDetails.
  assert.ok(lines.has("- Readiness: recorded — readiness recorded with one open contradiction (contradictions=1, unsafeAssumptions=0, missingCoverage=1)"));
  assert.ok(lines.has("- Blockers: budget-exhaustion; b1: qa fix rounds exhausted"));
  // Design: revision, decision, digest, screen-status count summary.
  assert.ok(lines.has("- Design: revision=2, decision=approved, digest=d41d8cd98f00b204e9800998ecf8427e, screens=1 approved/1 revise"));
  // 4 settled tasks exceed 3: exactly one compacted line, and the earliest
  // settled task (T-01) appears neither as a row nor via its artifacts.
  assert.ok(lines.has("- Settled tasks: 4 (latest: T-02, T-03, T-04)"));
  assert.ok(!digest.includes("T-01"), "settled task ids beyond the latest-3 tail must not appear");
  assert.ok(!digest.includes("docs/prd.md"), "settled tasks' artifact refs must not dump");
  // Every active/unaccepted task (no result, partial) keeps a full row.
  assert.ok(lines.has("- Task T-05 [dev · no result yet · epoch=2 · artifacts: none]"));
  assert.ok(lines.has("- Task T-06 [qa · partial · epoch=none · artifacts: qa/q1/bundle]"));
  // QA & fix section: latest audit only, active reservations, pending owner
  // requests, undelivered wakeups.
  assert.ok(lines.has("- QA latest audit: qa/audit-2/qa-report.json@aaaaaaaa"));
  assert.ok(lines.has("- Fix reservations: fix-1 (requestId=fr-1 · repair crash on checkout submit)"));
  assert.ok(lines.has("- Pending owner requests: q1 (question): Should the offline queue persist across restarts?"));
  assert.ok(lines.has("- Undelivered wakeups: w1->lead: Owner answered q1 — resume fixing"));
  assert.ok(!digest.includes("already answered question"), "answered owner requests are not pending");
  assert.ok(!digest.includes("already delivered"), "delivered wakeups are not undelivered");
  // Bounded digest, never a raw JSON dump of the run or its intent arrays.
  assert.ok(digest.length < 2500, `digest must stay bounded, got ${digest.length} chars`);
  assert.ok(!digest.includes("operationIntents"));
  assert.ok(!digest.includes("contractIntents"));
  assert.ok(!digest.includes(JSON.stringify(run)));
  assert.ok(!digest.includes("do-not-dump-operation-intents"));
});

test('Scrum-mode kickoff packet swaps in the Scrum MCP tool table, keeps the repo preflight and Project notebook, and appends the Active Scrum run digest (v0.2.0, ADR 0049 §2)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  const stateDir = makeTempDir(); disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "repo"), { recursive: true });
  writeFileSync(join(stateDir, "projects", "repo", "notebook.md"), "## 1. Verification & Run Recipe\n- Gate: npm test");
  const digest = formatScrumRunDigest(digestFixtureRun());

  for (const role of ["supervisor", "lead"] as const) {
    const packet = buildSeatKickoffPacket({
      role, projectSlug: "repo", projectRoot: root, ledgerEvents: [],
      stateDir, mode: "scrum", scrumRunDigest: digest,
    });
    const lines = new Set(packet.split("\n"));
    const scrumTools = role === "supervisor" ? SCRUM_SUPERVISOR_MCP_TOOLS : SCRUM_LEAD_MCP_TOOLS;
    assert.ok(lines.has(`- Role MCP tools (paseo_factory): ${scrumTools}`), `${role} renders the Scrum MCP tool table`);
    assert.ok(!packet.includes(role === "supervisor" ? "supervisor_read_ledger" : "lead_verify"), `${role} packet must not render the SLP tool table`);
    // Every deterministic repo preflight line and the Project notebook stay.
    assert.match(packet, /- Git: branch=`.*`, head=`.*`, status=clean/);
    assert.match(packet, /- Top-level files: /);
    assert.match(packet, /- Ledger tasks: none \(clean slate\)/);
    assert.ok(lines.has(`- Project notebook path: ${projectNotebookPath(stateDir, "repo")}`));
    assert.ok(lines.has("## 1. Verification & Run Recipe"));
    // The bounded run digest rides under its own marker, in full.
    assert.ok(lines.has("- Active Scrum run digest:"));
    for (const line of digest.split("\n")) {
      assert.ok(lines.has(line), `${role} packet missing digest line: ${JSON.stringify(line)}`);
    }
  }

  // mode: "scrum" without scrumRunDigest: no digest block at all.
  const bare = buildSeatKickoffPacket({ role: "lead", projectSlug: "repo", projectRoot: root, ledgerEvents: [], mode: "scrum" });
  assert.ok(!bare.includes("Active Scrum run digest"));
});

test('Scrum-mode kickoff packet with omitSystemPromptDuplicates drops the blocks renderScrumPrompt already carries, keeping the Scrum tool table and run digest (v0.2.0, ADR 0049 §2)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify({ projectId: 'owner', projectName: 'Checkout flow', sourceUpdatedAt: 1, syncedAt: '2026-11-02', screenCount: 4, files: [], digest: 'abc' }));
  const helperMcps = [{ name: "supabase", transport: "http" as const, status: "auth_expired" as const, enabled: true }];
  const digest = formatScrumRunDigest(digestFixtureRun());

  for (const role of ['supervisor', 'lead'] as const) {
    const lean = buildSeatKickoffPacket({
      role, projectSlug: 'repo', projectRoot: root, ledgerEvents: [], helperMcps,
      mode: "scrum", omitSystemPromptDuplicates: true, scrumRunDigest: digest,
    });
    // No duplicate of what config.systemPrompt (renderScrumPrompt) carries:
    // the linked-design spec, the OPEN_DESIGN_CONTRACT text, or the helper roster.
    assert.doesNotMatch(lean, /Open Design Linked Specification/);
    assert.ok(!lean.includes("Open Design UX contract"), "OPEN_DESIGN_CONTRACT text must not duplicate into the packet");
    assert.doesNotMatch(lean, /Available Peer Helper MCPs/);
    // The Scrum-scoped blocks stay.
    assert.ok(lean.includes(`- Role MCP tools (paseo_factory): ${role === 'supervisor' ? SCRUM_SUPERVISOR_MCP_TOOLS : SCRUM_LEAD_MCP_TOOLS}`));
    assert.ok(lean.includes("- Active Scrum run digest:"));
    for (const line of digest.split("\n")) {
      assert.ok(lean.includes(line), `${role} lean packet missing digest line: ${JSON.stringify(line)}`);
    }
  }
});

test('omitting mode (or passing "slp") keeps the SLP kickoff packet byte-for-byte identical for both roles (v0.2.0)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  for (const role of ["supervisor", "lead"] as const) {
    const base = { role, projectSlug: "repo", projectRoot: root, ledgerEvents: [] };
    const full = buildSeatKickoffPacket(base);
    assert.equal(buildSeatKickoffPacket({ ...base, mode: "slp" }), full);
    // scrumRunDigest is ignored outside mode: "scrum" — no digest block leaks.
    assert.equal(buildSeatKickoffPacket({ ...base, mode: undefined, scrumRunDigest: "must be ignored" }), full);
    assert.ok(!full.includes("Active Scrum run digest"));
  }
});
