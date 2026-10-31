import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createFactory } from '../plugin/server/core/factory.ts';
import { CorrelationRegistry } from '../plugin/server/core/correlations.ts';
import { resolveProject } from '../plugin/server/core/project.ts';
import type { ScrumRun } from '../plugin/server/core/scrum/run-journal.ts';
import { createSurfaceHandlers } from '../plugin/server/surface-rpc.ts';
import type { SurfaceDaemonApi } from '../plugin/server/surface-rpc.ts';
import { handleSpoolRequest } from '../plugin/server/spool.ts';
import type { ScrumOperation } from '../plugin/server/core/scrum/controller.ts';
import { makeTempDir, disposeDir, gitCommitAll } from './helpers.ts';

async function ownerWorkFixture(t: TestContext, budgets = { maxTasks: 24, maxQaFixRounds: 2 }) {
  const home = makeTempDir(), root = makeTempDir();
  for (const dir of [home, root]) disposeDir(t, dir);
  const stateDir = join(home, 'plugin-state/paseo-factory');
  writeFileSync(join(root, 'README.md'), 'Owner work fixture\n');
  gitCommitAll(root);
  const project = resolveProject(root); assert.ok(project.ok);
  const daemon = { agents: { list: async () => ({ entries: [], pageInfo: {} }) } } as unknown as SurfaceDaemonApi;
  let factory = createFactory({ stateDir });
  const wakeups = new Map<string, string>(), reports = new Map<string, string>();
  let notificationFails = false;
  const build = () => createSurfaceHandlers({ factory, stateDir, home, daemon, leadDispatch: async request => {
    if (notificationFails) throw new Error('daemon offline');
    wakeups.set(request.id, request.message);
    return { id: request.id, ok: true, summary: 'durably queued' };
  }, supervisorReport: async request => {
    if (notificationFails) throw new Error('daemon offline');
    reports.set(request.id, request.message);
    return { id: request.id, ok: true, summary: 'question queued' };
  } });
  let handlers = build();
  assert.equal((await handlers.executionSetMode({ projectRoot: root, mode: 'scrum' })).ok, true);
  const lead = new CorrelationRegistry(stateDir).issue({ role: 'lead', projectSlug: project.slug, projectRoot: root });
  const agent = new CorrelationRegistry(stateDir).issue({ role: 'agent', projectSlug: project.slug, projectRoot: root, task: 'dependent' });
  const call = (input: ScrumOperation, submitter = 'owner') => handleSpoolRequest(factory, {
    ...input, id: input.requestId, kind: 'scrum_command', projectRoot: root, submitter,
  }, { scrumCommand: async (request, caller) => {
    const reply = await handlers.scrumCommand(request, undefined, caller);
    return reply.ok ? { id: request.id, ok: true, summary: 'Scrum command', data: reply.data } : { id: request.id, ok: false, code: reply.code, message: reply.error };
  } });
  const created = await call({ operation: 'run.create', runId: 'run', requestId: 'create', payload: { initiativeId: 'owner-work', track: 'quick', rationale: 'public Owner lifecycle fixture', budgets } });
  assert.ok(created.ok, JSON.stringify(created));
  const get = async () => {
    const reply = await call({ operation: 'get', requestId: 'get' }); assert.ok(reply.ok);
    return (reply.data as { runs: ScrumRun[] }).runs[0];
  };
  const command = async (operation: string, requestId: string, payload: Record<string, unknown>, submitter = 'owner') => call({ operation, runId: 'run', requestId, expectedRevision: (await get()).revision, payload }, submitter);
  const contract = (task: string, role: 'pm' | 'ux' | 'architect' | 'dev' | 'qa' = 'pm') => handleSpoolRequest(factory, { id: `contract-${task}`, kind: 'contract', task, role, runId: 'run', workspace: root, gate: 'true', scope: [`.scratch/owner-work/qa/${task}.md`], artifact: `.scratch/owner-work/qa/${task}.md`, submitter: lead.correlationId, seat: 'lead' });
  return { root, stateDir, project, get, call, command, contract, lead: lead.correlationId, agent: agent.correlationId, wakeups, reports,
    handlers: () => handlers,
    restart: () => { factory = createFactory({ stateDir }); handlers = build(); },
    failNotification: (fail: boolean) => { notificationFails = fail; },
  };
}

test('old Scrum runs admit useful Tasks without time top-ups and still require Dev readiness', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 25) });
  const f = await ownerWorkFixture(t);
  t.mock.timers.setTime(Date.UTC(2026, 9, 31));
  const pm = await f.contract('pm'); assert.ok(pm.ok, JSON.stringify(pm));
  const dev = await f.contract('dev', 'dev'); assert.equal(dev.ok, false);
  if (!dev.ok) assert.equal(dev.code, 'scrum-readiness-required');
  assert.equal((await f.get()).tasks.length, 1);
  assert.deepEqual((await f.get()).blockers, []);
});

test('Owner grants add separate cumulative Task and QA capacity and replay once after restart', async t => {
  const f = await ownerWorkFixture(t, { maxTasks: 1, maxQaFixRounds: 0 });
  assert.ok((await f.contract('first')).ok);
  const exhausted = await f.contract('ux-r02', 'qa'); assert.equal(exhausted.ok, false);
  if (!exhausted.ok) { assert.equal(exhausted.code, 'scrum-task-capacity-exhausted'); assert.match(exhausted.message, /1\/1/); }
  const before = await f.get();
  const request = { operation: 'allowance.tasks', runId: 'run', requestId: 'grant-8', expectedRevision: before.revision, payload: { amount: 8, rationale: 'Allow more UX revisions' } };
  const granted = await f.call(request); assert.ok(granted.ok, JSON.stringify(granted));
  let run = await f.get(); assert.equal(run.budgets.maxTasks, 9); assert.equal(run.tasks.length, 1); assert.equal(run.budgets.maxQaFixRounds, 0);
  assert.deepEqual(run.blockers, []);
  f.restart();
  assert.ok((await f.call(request)).ok);
  assert.equal((await f.get()).revision, run.revision);
  assert.equal((await f.get()).budgets.maxTasks, 9);
  assert.ok((await f.contract('ux-r02', 'qa')).ok);
  const qaExhausted = await f.command('run.command', 'fix', { type: 'fix_reserved', task: 'fix-1' }, f.lead);
  assert.equal(qaExhausted.ok, false); if (!qaExhausted.ok) assert.match(qaExhausted.message, /0\/0/);
  assert.ok((await f.command('allowance.tasks', 'more-tasks', { amount: 1, rationale: 'One more Task' })).ok);
  run = await f.get(); assert.equal(run.phase, 'blocked'); assert.match(run.blockers.join(' '), /QA/);
  assert.ok((await f.command('allowance.qa', 'one-qa-round', { amount: 1, rationale: 'One verified repair round' })).ok);
  run = await f.get(); assert.equal(run.budgets.maxQaFixRounds, 1); assert.equal(run.fixRounds, 0); assert.equal(run.tasks.length, 2);
  assert.deepEqual(run.blockers, []);
  assert.ok((await f.command('run.command', 'fix-again', { type: 'fix_reserved', task: 'fix-1' }, f.lead)).ok);
  assert.equal((await f.get()).fixRounds, 1);
});

test('durable questions hold only explicit dependencies; answers target one request and cancellation supplies no answer', async t => {
  const f = await ownerWorkFixture(t);
  for (const [pendingId, task] of [['q-one', 'dependent'], ['q-two', 'other-dependent']]) {
    const reply = await f.command('lead.operation', `ask-${pendingId}`, { action: 'wait.request', pendingId, question: `Choose semantics for ${task}`, affected: [{ kind: 'task', id: task }] }, f.lead);
    assert.ok(reply.ok, JSON.stringify(reply));
  }
  assert.ok((await f.contract('independent')).ok);
  const held = await f.contract('dependent'); assert.equal(held.ok, false);
  if (!held.ok) { assert.equal(held.code, 'scrum-owner-answer-required'); assert.match(held.message, /q-one/); }
  const requests = (await f.get()).ownerRequests;
  f.restart(); assert.deepEqual((await f.get()).ownerRequests, requests);
  const denied = await f.command('wait.answer', 'self-answer', { pendingId: 'q-one', rationale: 'I assume yes' }, f.lead); assert.equal(denied.ok, false);
  assert.ok((await f.command('wait.answer', 'answer-one', { pendingId: 'q-one', rationale: 'Use the saved product scope' })).ok);
  assert.ok((await f.contract('dependent')).ok);
  assert.equal((await f.contract('other-dependent')).ok, false);
  assert.ok((await f.command('wait.cancel', 'cancel-two', { pendingId: 'q-two', rationale: 'Question obsolete; work still held' })).ok);
  assert.equal((await f.contract('other-dependent')).ok, false);
  assert.ok((await f.contract('another-independent')).ok);
  const run = await f.get();
  assert.deepEqual(run.ownerRequests?.map(r => [r.id, r.status]), [['q-one', 'answered'], ['q-two', 'cancelled']]);
  f.restart(); assert.deepEqual((await f.get()).ownerRequests, run.ownerRequests);
  const snapshot = await f.handlers().snapshot({ projectRoot: f.root }); assert.ok(snapshot.ok);
  if (snapshot.ok) assert.deepEqual(snapshot.view.execution?.run?.ownerRequests, run.ownerRequests);
});

test('invalid, unauthorized, stale, concurrent and changed-content grants cannot inflate capacity', async t => {
  const f = await ownerWorkFixture(t);
  for (const actor of [f.lead, f.agent]) {
    const reply = await f.command('allowance.tasks', `deny-${actor}`, { amount: 8, rationale: 'self grant' }, actor);
    assert.equal(reply.ok, false);
  }
  for (const [amount, rationale] of [[0, 'zero'], [-1, 'negative'], [1.5, 'fractional'], [Number.MAX_SAFE_INTEGER, 'overflow'], [8, ' '], ['8', 'string']] as const) {
    const reply = await f.command('allowance.tasks', `invalid-${amount}-${rationale}`, { amount, rationale }); assert.equal(reply.ok, false);
    assert.equal((await f.get()).budgets.maxTasks, 24);
  }
  assert.equal((await f.command('allowance.qa', 'qa-bundle', { amount: 2, rationale: 'two at once' })).ok, false);
  const revision = (await f.get()).revision;
  const make = (requestId: string, amount: number) => ({ operation: 'allowance.tasks', runId: 'run', requestId, expectedRevision: revision, payload: { amount, rationale: 'Owner explicitly allows more work' } });
  const replies = await Promise.all([f.call(make('concurrent-1', 8)), f.call(make('concurrent-2', 4))]);
  assert.equal(replies.filter(r => r.ok).length, 1);
  assert.equal((await f.get()).budgets.maxTasks, 32);
  const conflict = await f.call(make('concurrent-1', 4)); assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'run-request-conflict');
  assert.equal((await f.call({ ...make('wrong-run', 1), runId: 'absent' })).ok, false);
  assert.equal((await f.command('run.command', 'raw-grant', { type: 'allowance_granted', grant: { amount: 8 } })).ok, false);
  assert.equal((await f.get()).budgets.maxTasks, 32);
});

test('legacy continuation removes only proven elapsed exhaustion and persists an exactly-once wakeup before delivery', async t => {
  const f = await ownerWorkFixture(t);
  // A historical writer fixture, not a new command: legacy :exhausted receipts
  // and their event timestamp are the authority for the retired cause.
  const initial = await f.get();
  const createdAt = new Date(Date.now() - 7 * 86400_000).toISOString();
  const legacy = { ...initial, createdAt, budgets: { ...initial.budgets, maxElapsedMs: 7_200_000 }, phase: 'planning' };
  const events = [
    { revision: 1, requestId: 'create', fingerprint: 'legacy', ts: createdAt, payload: { type: 'created', run: legacy } },
    { revision: 2, requestId: 'ux-r02:reserve:exhausted', fingerprint: 'legacy-block', ts: new Date().toISOString(), payload: { type: 'blocked', requestId: 'ux-r02:reserve:exhausted', expectedRevision: 1, reason: 'Task/time budget exhausted' } },
  ];
  writeFileSync(join(f.stateDir, 'projects', f.project.slug, 'scrum/runs/run/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  f.restart(); assert.equal(f.wakeups.size, 0); assert.equal((await f.get()).phase, 'blocked');
  const request = { operation: 'run.continue', runId: 'run', requestId: 'recover', expectedRevision: 2, payload: { rationale: 'Continue the same run under ADR 0038' } };
  f.failNotification(true);
  const continued = await f.call(request); assert.ok(continued.ok, JSON.stringify(continued));
  assert.deepEqual((await f.get()).blockers, []);
  f.restart(); f.failNotification(false);
  assert.ok((await f.call(request)).ok);
  assert.equal(f.wakeups.size, 1);
  const recovered = await f.get();
  assert.equal(recovered.createdAt, createdAt); assert.equal(recovered.budgets.maxElapsedMs, 7_200_000);
  assert.ok((await f.call(request)).ok); assert.equal((await f.get()).revision, recovered.revision); assert.equal(f.wakeups.size, 1);
  assert.ok((await f.contract('ux-r02', 'qa')).ok);
  assert.ok((await f.contract('ux-r02', 'qa')).ok); assert.equal((await f.get()).tasks.length, 1);
});

for (const fixture of [
  { name: 'elapsed only', tasks: 3, maxTasks: 24, old: true, unrelated: false, recoverable: true },
  { name: 'Task only', tasks: 3, maxTasks: 3, old: false, unrelated: false, recoverable: false },
  { name: 'combined elapsed and Task', tasks: 3, maxTasks: 3, old: true, unrelated: false, recoverable: true },
  { name: 'elapsed plus unrelated QA', tasks: 3, maxTasks: 24, old: true, unrelated: true, recoverable: true },
  { name: 'ambiguous generic blocker', tasks: 0, maxTasks: 24, old: false, unrelated: false, recoverable: false },
]) test(`legacy recovery: ${fixture.name} preserves authoritative counts and other blockers`, async t => {
  const f = await ownerWorkFixture(t);
  const { artifactAt, designDigest } = await import('../plugin/server/core/scrum/artifacts.ts');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(f.root, '.scratch/owner-work'), { recursive: true });
  writeFileSync(join(f.root, '.scratch/owner-work/prd.md'), '# Accepted PRD\n');
  const sha = gitCommitAll(f.root);
  const prd = artifactAt(f.root, sha, '.scratch/owner-work/prd.md');
  const initial = await f.get(), now = Date.now();
  const createdAt = new Date(now - (fixture.old ? 7 * 86400_000 : 1000)).toISOString();
  const findings = ['goals', 'today', 'calendar', 'settings'].map(screen => ({ screen, note: `Repair ${screen} as requested`, status: 'revise' as const }));
  const reviewedAt = Date.parse(createdAt) + 3 * 3600_000;
  const legacy = { ...initial, createdAt, track: 'ui', phase: 'awaiting-ui-approval', awaitingApprovalSince: fixture.old ? reviewedAt : undefined,
    budgets: { ...initial.budgets, maxTasks: fixture.maxTasks, maxElapsedMs: 7_200_000 },
    ownedPaths: [prd.path], tasks: ['pm', 'ux-spec', 'architect'].slice(0, fixture.tasks).map((task, i) => ({ task, role: ['pm', 'ux', 'architect'][i], required: true, result: { status: 'complete', artifactRefs: i === 0 ? [prd] : [], assumptions: [], openQuestions: [], conflicts: [] } })),
    design: { revision: 1, digest: designDigest([prd]), refs: [prd], browserEvidence: [prd] },
  };
  const events: unknown[] = [
    { revision: 1, requestId: 'create', fingerprint: 'legacy', ts: createdAt, payload: { type: 'created', run: legacy } },
    { revision: 2, requestId: 'changes', fingerprint: 'legacy-decision', ts: new Date(now).toISOString(), payload: { type: 'design_decided', requestId: 'changes', expectedRevision: 1, revision: 1, digest: legacy.design.digest, decision: 'changes_requested', actor: 'owner', rationale: 'Repair all four screens', findings } },
    { revision: 3, requestId: 'ux-r02:reserve:exhausted', fingerprint: 'legacy-block', ts: new Date(now).toISOString(), payload: { type: 'blocked', requestId: 'ux-r02:reserve:exhausted', expectedRevision: 2, reason: 'Task/time budget exhausted' } },
  ];
  if (fixture.unrelated) events.push({ revision: 4, requestId: 'qa-problem', fingerprint: 'qa', ts: new Date(now).toISOString(), payload: { type: 'blocked', requestId: 'qa-problem', expectedRevision: 3, reason: 'QA inconclusive' } });
  writeFileSync(join(f.stateDir, 'projects', f.project.slug, 'scrum/runs/run/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  f.restart(); const before = await f.get(); assert.equal(f.wakeups.size, 0);
  const bypass = await f.command('run.command', 'clear-all', { type: 'blockers_resolved', resolution: 'Lead attempts blanket resume' }, f.lead);
  assert.equal(bypass.ok, false); assert.deepEqual(await f.get(), before);
  const reply = await f.command('run.continue', 'continue', { rationale: 'Retire the proven elapsed cause only' });
  assert.equal(reply.ok, fixture.recoverable, JSON.stringify(reply));
  const after = await f.get();
  assert.deepEqual(after.tasks, before.tasks); assert.equal(after.decisions, 1); assert.deepEqual(after.design?.findings, findings);
  assert.equal(after.budgets.maxElapsedMs, before.budgets.maxElapsedMs);
  if (fixture.recoverable && fixture.tasks < fixture.maxTasks && !fixture.unrelated) {
    assert.equal(after.phase, 'design'); assert.equal(f.wakeups.size, 1);
    const revision = await f.contract('ux-r02', 'ux'); assert.ok(revision.ok, JSON.stringify(revision));
    assert.equal((await f.get()).tasks.length, 4); assert.equal((await f.get()).design?.decision, 'changes_requested');
    assert.equal((await f.contract('dev', 'dev')).ok, false);
  } else {
    assert.equal(after.phase, 'blocked'); assert.equal(f.wakeups.size, 0);
    if (fixture.unrelated) assert.deepEqual(after.blockers, ['QA inconclusive']);
    if (fixture.tasks === fixture.maxTasks) {
      assert.ok(after.blockerDetails?.some(b => b.causes.includes('tasks')));
      assert.ok((await f.command('allowance.tasks', 'grant', { amount: 8, rationale: 'Permit UX revision' })).ok);
      if (!fixture.old || fixture.recoverable) assert.deepEqual((await f.get()).blockers, []);
    }
  }
  const final = await f.get(); f.restart(); assert.deepEqual(await f.get(), final);
});

test('UI review survives nights and reconstruction, keeps findings, and generic replies cannot approve the next revision', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 25) });
  const { designFixture } = await import('./fixtures/scrum-design.ts');
  const { cpSync } = await import('node:fs');
  const f = await designFixture(t);
  const submitted = f.submit() as ScrumRun;
  const project = resolveProject(f.root); assert.ok(project.ok);
  // Reuse the accepted design fixture under the real Surface Project identity.
  cpSync(join(f.state, 'projects/p'), join(f.state, 'projects', project.slug), { recursive: true });
  const daemon = { agents: { list: async () => ({ entries: [], pageInfo: {} }) } } as unknown as SurfaceDaemonApi;
  const build = () => createSurfaceHandlers({ factory: createFactory({ stateDir: f.state }), stateDir: f.state, home: f.state, daemon });
  let handlers = build();
  const get = async () => {
    const reply = await handlers.scrumCommand({ operation: 'get', requestId: 'get', projectRoot: f.root }); assert.ok(reply.ok);
    return (reply.data as { runs: ScrumRun[] }).runs[0];
  };
  const review = submitted.ownerRequests![0];
  for (let night = 1; night <= 4; night++) {
    t.mock.timers.setTime(Date.UTC(2026, 9, 25 + night)); handlers = build();
    const run = await get(); assert.equal(run.phase, 'awaiting-ui-approval'); assert.equal(run.ownerRequests?.[0].status, 'pending'); assert.equal(run.revision, submitted.revision);
  }
  const operate = async (operation: string, requestId: string, payload: Record<string, unknown>) => handlers.scrumCommand({ operation, requestId, projectRoot: f.root, runId: submitted.runId, expectedRevision: (await get()).revision, payload });
  for (const operation of ['wait.answer', 'wait.cancel']) assert.equal((await operate(operation, operation, { pendingId: review.id, rationale: 'yes' })).ok, false);
  const changes = { decision: 'changes_requested', revision: 1, digest: f.design.digest, rationale: 'Fix checkout contrast', findings: [{ screen: 'checkout', note: 'Contrast too low' }] };
  const decided = await operate('design.decide', 'changes', changes); assert.ok(decided.ok, JSON.stringify(decided));
  const after = await get(); assert.equal(after.phase, 'design'); assert.equal(after.ownerRequests?.[0].resolution?.outcome, 'changes_requested'); assert.equal(after.budgets.maxElapsedMs, submitted.budgets.maxElapsedMs);
  const next = await operate('run.command', 'review-2', { type: 'design_review_requested', design: { ...f.design, revision: 2 } }); assert.ok(next.ok, JSON.stringify(next));
  const run = await get(); assert.equal(run.ownerRequests?.filter(r => r.status === 'pending').length, 1); assert.notEqual(run.ownerRequests?.[1].id, review.id);
  assert.equal((await operate('design.decide', 'stale-review', changes)).ok, false);
  assert.equal((await operate('wait.answer', 'stale-question', { pendingId: review.id, rationale: 'approved' })).ok, false);
  assert.equal((await get()).design?.decision, undefined);
  assert.equal((await get()).ownerRequests?.[0].resolution?.rationale, 'Fix checkout contrast');
});

test('question replies are idempotent across restart and reject conflicting or stale answers without releasing other holds', async t => {
  const f = await ownerWorkFixture(t);
  assert.ok((await f.command('wait.request', 'ask', { pendingId: 'q', question: 'Choose product semantics', affected: [{ kind: 'stage', id: 'implementation' }] })).ok);
  const request = { operation: 'wait.answer', runId: 'run', requestId: 'answer', expectedRevision: (await f.get()).revision, payload: { pendingId: 'q', rationale: 'Use saved semantics' } };
  const answered = await f.call(request); assert.ok(answered.ok, JSON.stringify(answered));
  const run = await f.get(); f.restart(); assert.ok((await f.call(request)).ok); assert.deepEqual(await f.get(), run);
  const conflict = await f.call({ ...request, payload: { ...request.payload, rationale: 'Different answer' } }); assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'run-request-conflict');
  assert.equal((await f.call({ ...request, requestId: 'stale-new-answer', expectedRevision: 1 })).ok, false);
  assert.equal((await f.command('wait.answer', 'another-answer', request.payload)).ok, false);
  assert.deepEqual(await f.get(), run);
});

test('terminal and cancellation-pending runs reject Owner grants and question resolutions without mutation', async t => {
  for (const pendingCancellation of [false, true]) {
    const f = await ownerWorkFixture(t);
    assert.ok((await f.command('wait.request', 'ask', { pendingId: 'q', question: 'Pending decision', affected: [{ kind: 'task', id: 'held' }] })).ok);
    if (pendingCancellation) {
      const { commandRun } = await import('../plugin/server/core/scrum/run-journal.ts');
      commandRun(f.stateDir, f.project.slug, 'run', { type: 'cancellation_requested', actor: 'owner', reason: 'Historical interrupted cancellation', requestId: 'cancel', expectedRevision: (await f.get()).revision });
    } else {
      assert.ok((await f.command('run.cancel', 'cancel', { reason: 'Owner cancelled work' })).ok);
    }
    const before = await f.get();
    for (const [operation, payload] of [['allowance.tasks', { amount: 8, rationale: 'capacity' }], ['allowance.qa', { amount: 1, rationale: 'repair' }], ['wait.answer', { pendingId: 'q', rationale: 'answer' }], ['run.continue', { rationale: 'continue' }]] as const) {
      const reply = await f.command(operation, operation, payload); assert.equal(reply.ok, false);
    }
    assert.deepEqual(await f.get(), before);
  }
});

test('a fixing-stage Owner wait also holds a repair reserved before the question', async t => {
  const f = await ownerWorkFixture(t);
  const { commandRun } = await import('../plugin/server/core/scrum/run-journal.ts');
  // The existing readiness fixture output isolates the repair admission seam.
  commandRun(f.stateDir, f.project.slug, 'run', { type: 'readiness_recorded', requestId: 'ready-fixture', expectedRevision: (await f.get()).revision, readiness: { refs: [], contradictions: [], unsafeAssumptions: [], missingCoverage: [], rationale: 'Existing quick-track product readiness fixture' } });
  assert.ok((await f.command('run.command', 'reserve-fix', { type: 'fix_reserved', task: 'repair' }, f.lead)).ok);
  assert.ok((await f.command('wait.request', 'ask-fix', { pendingId: 'q-fix', question: 'Choose repair semantics', affected: [{ kind: 'stage', id: 'fixing' }] })).ok);
  const held = await f.contract('repair', 'dev'); assert.equal(held.ok, false);
  if (!held.ok) { assert.equal(held.code, 'scrum-owner-answer-required'); assert.match(held.message, /q-fix/); }
  assert.ok((await f.contract('independent', 'qa')).ok);
  assert.ok((await f.command('wait.answer', 'answer-fix', { pendingId: 'q-fix', rationale: 'Keep the original invariant' })).ok);
  assert.ok((await f.contract('repair', 'dev')).ok);
});

test('notification recovery suppresses a question answered before its delayed Supervisor report', async t => {
  const f = await ownerWorkFixture(t);
  f.failNotification(true);
  assert.ok((await f.command('wait.request', 'ask', { pendingId: 'q-delay', question: 'Choose semantics', affected: [{ kind: 'task', id: 'dependent' }] })).ok);
  assert.equal(f.reports.size, 0);
  assert.ok((await f.command('wait.answer', 'answer', { pendingId: 'q-delay', rationale: 'Use the documented choice' })).ok);
  f.restart(); f.failNotification(false);
  await f.handlers().scrumRecoverNotifications({ root: f.root, slug: f.project.slug }, 'run');
  assert.equal(f.reports.size, 0, 'answered question must not be relayed as waiting');
  assert.equal(f.wakeups.size, 1, 'the answer still reaches Lead once');
  const run = await f.get(); assert.ok(run.wakeups?.every(w => w.delivered));
  await f.handlers().scrumRecoverNotifications({ root: f.root, slug: f.project.slug }, 'run');
  assert.equal(f.wakeups.size, 1);
});

test('retrying an earlier blocker resolution cannot clear a newer protected count blocker', async t => {
  const f = await ownerWorkFixture(t, { maxTasks: 1, maxQaFixRounds: 2 });
  assert.ok((await f.command('run.command', 'other-blocker', { type: 'blocked', reason: 'Temporary fixture permission question' }, f.lead)).ok);
  const request = { operation: 'run.command', runId: 'run', requestId: 'resolved-earlier', expectedRevision: (await f.get()).revision, payload: { type: 'blockers_resolved', resolution: 'Permission resolved' } };
  assert.ok((await f.call(request, f.lead)).ok);
  assert.ok((await f.command('run.command', 'planning', { type: 'phase_changed', phase: 'planning', reason: 'Resume planning' }, f.lead)).ok);
  assert.ok((await f.contract('first')).ok); assert.equal((await f.contract('second')).ok, false);
  const blocked = await f.get();
  const replay = await f.call(request, f.lead); assert.ok(replay.ok, JSON.stringify(replay));
  assert.deepEqual(await f.get(), blocked);
  assert.equal((await f.command('run.command', 'new-blanket-clear', request.payload, f.lead)).ok, false);
});
