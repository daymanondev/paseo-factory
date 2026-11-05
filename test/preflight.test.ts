import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, disposeDir } from "./helpers.ts";
import { buildSeatKickoffPacket } from "../src/preflight.ts";
import { renderScrumPrompt } from "../src/scrum/prompts.ts";
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
