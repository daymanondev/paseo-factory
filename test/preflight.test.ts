import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir, factoryErrorCode } from "./helpers.ts";
import { buildSeatKickoffPacket, writeProjectNotebook, syncLegacyScratchNotebook, PROJECT_NOTEBOOK_MAX_GUARD_ROWS } from "../src/preflight.ts";
import { projectNotebookPath } from "../src/project.ts";
import { FactoryError } from "../src/errors.ts";
import { LEAD_WAVE_LAWS, SUPERVISOR_OUTCOME_BOUNDARY } from "../src/roles-contract.ts";
import type { LedgerEvent } from "../src/events.ts";

test("kickoff packets report present and absent project memory", t => {
  const root = makeTempDir(); disposeDir(t, root);
  const input = { role: "lead" as const, projectSlug: "empty", projectRoot: root, ledgerEvents: [] };
  assert.match(buildSeatKickoffPacket(input), /Project memory: none present on disk/);
  writeFileSync(join(root, "AGENTS.md"), "rules");
  const packet = buildSeatKickoffPacket(input);
  assert.match(packet, /read before acting: AGENTS.md/);
  assert.match(packet, /CLAUDE.md \(absent — do not call read_file\)/);
  assert.match(packet, /CONTEXT.md \(absent — do not call read_file\)/);
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

test('linked Owner designs are authoritative in seat kickoff', async t => {
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
  const ledgerRows = (tasks: Array<{ task: string; stage: 'contracted' | 'green' | 'accepted' | 'closed' }>): LedgerEvent[] => {
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
      if (stage === 'closed') {
        events.push({ seq: seq++, ts: '2026-11-05T00:00:00Z', event: 'task_closed', task, reason: 'superseded by the split', closed_by: 'lead' });
      }
    }
    return events;
  };
  const ledgerLine = (events: LedgerEvent[]): string =>
    buildSeatKickoffPacket({ role: 'lead', projectSlug: 'repo', projectRoot: root, ledgerEvents: events }).split('\n')
      .find(line => line.startsWith('- Ledger tasks: ')) ?? '(ledger line missing)';

  // > 3 accepted: closed history (accepted or retired, ADR 0054 §5) collapses
  // into one count + latest-3 prefix; unaccepted tasks keep their full
  // [status, attempts, verdict] entry.
  const crowded = ledgerRows([
    { task: 'T-00', stage: 'closed' },
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
    '- Ledger tasks: 6 accepted/closed (latest: T-03, T-04, T-05); T-06 [green, attempts=1, verdict=green]; T-07 [contracted, attempts=0, verdict=none]',
  );

  // <= 3 accepted: today's per-task rendering is preserved for every row —
  // a lone retired Task names its own row the same way.
  const small = ledgerRows([{ task: 'T-01', stage: 'accepted' }, { task: 'T-02', stage: 'accepted' }, { task: 'T-03', stage: 'green' }]);
  assert.equal(
    ledgerLine(small),
    '- Ledger tasks: T-01 [accepted (by owner), attempts=1, verdict=green]; T-02 [accepted (by owner), attempts=1, verdict=green]; T-03 [green, attempts=1, verdict=green]',
  );
  const retired = ledgerRows([{ task: 'T-09', stage: 'closed' }]);
  assert.equal(
    ledgerLine(retired),
    '- Ledger tasks: T-09 [closed (by lead), attempts=1, verdict=green]',
  );
});

test('the kickoff packet renders the SLP MCP tool table and the Project notebook for both roles, with no Scrum vocabulary (ADR 0056)', t => {
  const root = makeTempDir(); disposeDir(t, root);
  const stateDir = makeTempDir(); disposeDir(t, stateDir);
  mkdirSync(join(stateDir, "projects", "repo"), { recursive: true });
  writeFileSync(join(stateDir, "projects", "repo", "notebook.md"), "## 1. Verification & Run Recipe\n- Gate: npm test");

  for (const role of ["supervisor", "lead"] as const) {
    const packet = buildSeatKickoffPacket({ role, projectSlug: "repo", projectRoot: root, ledgerEvents: [], stateDir });
    const lines = new Set(packet.split("\n"));
    const tools = role === "supervisor"
      ? "`supervisor_dispatch_lead`, `supervisor_read_ledger`, `supervisor_end_cycle`"
      : "`lead_set_contract`, `lead_dispatch_agent`, `lead_verify`, `lead_merge`, `lead_report_to_supervisor`";
    assert.ok(lines.has(`- Role MCP tools (paseo_factory): ${tools}`), `${role} renders the SLP MCP tool table`);
    assert.doesNotMatch(packet, /scrum/i, `${role} packet carries no Scrum vocabulary`);
    // Every deterministic repo preflight line and the Project notebook ride the packet.
    assert.match(packet, /- Git: branch=`.*`, head=`.*`, status=clean/);
    assert.match(packet, /- Top-level files: /);
    assert.match(packet, /- Ledger tasks: none \(clean slate\)/);
    assert.ok(lines.has(`- Project notebook path: ${projectNotebookPath(stateDir, "repo")}`));
    assert.ok(lines.has("## 1. Verification & Run Recipe"));
  }
});

// ---- the plugin-owned notebook writer + legacy promotion (v0.5.0, ADR 0052 §1) --------------

/** A canonical-shape notebook: both required headings plus a headered Recurrence Guard table. */
function validNotebook(guardRows = 3): string {
  const rows = Array.from({ length: guardRows }, (_, i) => `| V-${String(i + 1).padStart(2, "0")} | cause ${i + 1} → effect ${i + 1} | observed (1x) |`);
  return [
    "# Project notebook",
    "",
    "## 1. Verification & Run Recipe",
    "npm run check",
    "",
    "## 2. Recurrence Guard",
    "| ID | Cause → Effect | State |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

test("writeProjectNotebook persists a valid notebook at exactly <projectStateDir>/notebook.md (spec User Story 22)", (t) => {
  const stateDir = makeTempDir("notebook-writer-");
  disposeDir(t, stateDir);
  const content = validNotebook(3);
  const path = writeProjectNotebook(stateDir, content, "demo-abc123");
  assert.equal(path, projectNotebookPath(stateDir, "demo-abc123"));
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), content, "the write is verbatim — never truncated");
});

test("writeProjectNotebook refuses a notebook missing a required heading with notebook-schema-invalid naming it", (t) => {
  const stateDir = makeTempDir("notebook-schema-");
  disposeDir(t, stateDir);
  const noGuard = validNotebook(2).replace("## 2. Recurrence Guard", "## 2. Notes");
  assert.throws(() => writeProjectNotebook(stateDir, noGuard, "demo-abc123"), factoryErrorCode("notebook-schema-invalid"));
  try {
    writeProjectNotebook(stateDir, noGuard, "demo-abc123");
    assert.fail("the malformed write must refuse");
  } catch (err) {
    assert.match((err as Error).message, /## 2\. Recurrence Guard/, "the refusal names the missing heading");
  }
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false, "a refused write persists nothing");
});

test("writeProjectNotebook refuses over-limit notebooks with notebook-limit-exceeded naming the exact counts — never truncating", (t) => {
  const stateDir = makeTempDir("notebook-limits-");
  disposeDir(t, stateDir);
  // 81 lines: a valid heading skeleton padded past the 80-line cap.
  const pad = Array.from({ length: 74 }, (_, i) => `recipe line ${i + 1}`);
  const overLines = ["## 1. Verification & Run Recipe", ...pad, "", "## 2. Recurrence Guard", "| ID | Cause | State |", "| --- | --- | --- |", "| V-01 | c → e | verified |", ""].join("\n");
  assert.equal(overLines.split("\n").length, 81);
  assert.throws(() => writeProjectNotebook(stateDir, overLines, "demo-abc123"), factoryErrorCode("notebook-limit-exceeded"));
  try {
    writeProjectNotebook(stateDir, overLines, "demo-abc123");
    assert.fail("the over-line write must refuse");
  } catch (err) {
    assert.match((err as Error).message, /81 lines/, "the refusal names the exact line count");
    assert.match((err as Error).message, /max 80/);
  }
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false, "an over-limit write persists nothing");

  // > 4,096 UTF-8 bytes while under the line and row caps ("đ" is 2 bytes per char).
  const longRecipe = Array.from({ length: 60 }, () => `đ`.repeat(90)).join("\n");
  const overBytes = `## 1. Verification & Run Recipe\n${longRecipe}\n\n## 2. Recurrence Guard\n| ID | Cause | State |\n| --- | --- | --- |\n| V-01 | c → e | verified |\n`;
  assert.ok(overBytes.split("\n").length <= 80 && Buffer.byteLength(overBytes, "utf8") > 4096, "fixture exceeds only the byte cap");
  try {
    writeProjectNotebook(stateDir, overBytes, "demo-abc123");
    assert.fail("the over-byte write must refuse");
  } catch (err) {
    assert.equal((err as FactoryError).code, "notebook-limit-exceeded");
    assert.match((err as Error).message, /UTF-8 bytes \(max 4096\)/, "the refusal names the byte cap");
  }
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false, "an over-byte write persists nothing");

  // 13 active Recurrence Guard rows.
  const overRows = validNotebook(13);
  try {
    writeProjectNotebook(stateDir, overRows, "demo-abc123");
    assert.fail("the over-row write must refuse");
  } catch (err) {
    assert.equal((err as FactoryError).code, "notebook-limit-exceeded");
    assert.match((err as Error).message, /13 Recurrence Guard rows/, "the refusal names the exact row count");
    assert.match((err as Error).message, /max 12/);
    assert.match((err as Error).message, /fold|graduate|retire/i, "the refusal instructs the Lead to graduate rows");
  }
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false, "an over-row write persists nothing");
});

test("writeProjectNotebook accepts the caps' exact edge: 80 lines and 12 active Recurrence Guard rows", (t) => {
  const stateDir = makeTempDir("notebook-edge-");
  disposeDir(t, stateDir);
  assert.equal(PROJECT_NOTEBOOK_MAX_GUARD_ROWS, 12);
  const rows = Array.from({ length: 12 }, (_, i) => `| V-${String(i + 1).padStart(2, "0")} | cause ${i + 1} → effect ${i + 1} | verified |`);
  const filler = Array.from({ length: 80 - 19 }, (_, i) => `recipe line ${i + 1}`);
  const edge = ["## 1. Verification & Run Recipe", "npm run check", "", "## 2. Recurrence Guard", "| ID | Cause → Effect | State |", "| --- | --- | --- |", ...rows, ...filler, ""].join("\n");
  assert.equal(edge.split("\n").length, 80, "fixture sits exactly at the line cap");
  const path = writeProjectNotebook(stateDir, edge, "demo-abc123");
  assert.equal(readFileSync(path, "utf8"), edge);
});

test("writeProjectNotebook unlinks a legacy <project-root>/.scratch/notebook.md after the successful canonical write", (t) => {
  const stateDir = makeTempDir("notebook-legacy-");
  disposeDir(t, stateDir);
  const projectRoot = makeTempDir("notebook-legacy-root-");
  disposeDir(t, projectRoot);
  mkdirSync(join(projectRoot, ".scratch"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), validNotebook(1));
  const fresh = validNotebook(2);
  writeProjectNotebook(stateDir, fresh, "demo-abc123", projectRoot);
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), fresh, "the canonical write wins, not the stale legacy copy");
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), false, "the working-tree copy self-cleans");
});

test("syncLegacyScratchNotebook promotes an untracked legacy scratch notebook when the canonical is absent or older, then unlinks it (ADR 0052 §1)", (t) => {
  const stateDir = makeTempDir("notebook-sync-");
  disposeDir(t, stateDir);
  const projectRoot = makeTempDir("notebook-sync-root-");
  disposeDir(t, projectRoot);
  // An already-clean project is a no-op.
  assert.deepEqual(syncLegacyScratchNotebook(stateDir, "demo-abc123", projectRoot), { promoted: false, unlinked: false });
  assert.equal(existsSync(projectNotebookPath(stateDir, "demo-abc123")), false);

  // Canonical absent: promote the legacy bytes verbatim, then unlink the working-tree copy.
  const legacy = validNotebook(4);
  mkdirSync(join(projectRoot, ".scratch"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), legacy);
  assert.deepEqual(syncLegacyScratchNotebook(stateDir, "demo-abc123", projectRoot), { promoted: true, unlinked: true });
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), legacy);
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), false, "the untracked copy never reaches a clean-tree check");

  // Canonical older than the fresh legacy copy: promote again.
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), validNotebook(5));
  const stale = new Date(Date.now() - 120_000);
  utimesSync(projectNotebookPath(stateDir, "demo-abc123"), stale, stale);
  assert.deepEqual(syncLegacyScratchNotebook(stateDir, "demo-abc123", projectRoot), { promoted: true, unlinked: true });
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), validNotebook(5));

  // Canonical newer (a lead_update_notebook write just landed): no promotion, but the stale legacy copy still unlinks.
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), validNotebook(1));
  utimesSync(join(projectRoot, ".scratch", "notebook.md"), stale, stale);
  assert.deepEqual(syncLegacyScratchNotebook(stateDir, "demo-abc123", projectRoot), { promoted: false, unlinked: true });
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), validNotebook(5), "the newer canonical notebook survives untouched");
});

test("the seat kickoff packet promotes a legacy scratch notebook when it carries the Project root (ADR 0052 §1)", (t) => {
  const stateDir = makeTempDir("notebook-kickoff-");
  disposeDir(t, stateDir);
  const projectRoot = makeTempDir("notebook-kickoff-root-");
  disposeDir(t, projectRoot);
  const legacy = validNotebook(2);
  mkdirSync(join(projectRoot, ".scratch"), { recursive: true });
  writeFileSync(join(projectRoot, ".scratch", "notebook.md"), legacy);
  const packet = buildSeatKickoffPacket({ role: "lead", projectSlug: "demo-abc123", projectRoot, ledgerEvents: [], stateDir });
  assert.match(packet, /Project notebook/, "the packet carries the notebook block");
  assert.equal(readFileSync(projectNotebookPath(stateDir, "demo-abc123"), "utf8"), legacy, "the read promoted the legacy copy");
  assert.equal(existsSync(join(projectRoot, ".scratch", "notebook.md")), false, "the untracked copy is gone before any clean-tree check");
});
