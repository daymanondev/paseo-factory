import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFactory } from '../plugin/server/core/factory.ts';
import { createSurfaceHandlers, type SurfaceAgentSnapshot, type SurfaceDaemonApi } from '../plugin/server/surface-rpc.ts';
import { createLeadMailRuntime } from '../plugin/server/lead-mailbox.ts';
import { resolveProject, projectStateDir, writeProjectRegistration, readProjectRegistration } from '../plugin/server/core/project.ts';
import { readLeadMailbox } from '../plugin/server/core/mailbox.ts';
import { saveLanes } from '../plugin/server/core/lanes.ts';
import { disposeDir, gitCommitAll, makeTempDir } from './helpers.ts';

function fixture(t: TestContext, options: { parented?: boolean; timeout?: number } = {}) {
  const dir = makeTempDir(); disposeDir(t, dir);
  const root = join(dir, 'repo'); mkdirSync(root); writeFileSync(join(root, 'README.md'), 'hello\n'); gitCommitAll(root);
  const project = resolveProject(root); assert.ok(project.ok);
  const stateDir = join(dir, 'state'); const factory = createFactory({ stateDir });
  saveLanes(stateDir, { supervisor: 'pi/zai/glm-5.3', lead: 'pi/zai/glm-5.3' });
  writeProjectRegistration(stateDir, project.slug, { root: project.root, supervisor: 'old', lead: 'lead', workspaceId: 'workspace' });
  const agents: SurfaceAgentSnapshot[] = ['old', 'lead'].map(id => ({ id, provider: 'pi/zai/glm-5.3', title: id, status: 'idle', model: 'zai/glm-5.3', labels: { seat: id === 'old' ? 'supervisor' : 'lead', project: project.slug }, archivedAt: null, requiresAttention: false, attentionReason: null, updatedAt: new Date().toISOString(), cwd: project.root, workspaceId: 'workspace', ...(id === 'lead' && options.parented ? { parentAgentId: 'old' } : {}) }));
  const sent: { id: string; text: string }[] = []; const archived: string[] = []; const stopped: string[] = []; const created: { provider: string }[] = [];
  let failCreate = false; let failSend = false;
  const daemon: SurfaceDaemonApi = {
    agents: {
      list: async () => ({ entries: agents.filter(a => !a.archivedAt).map(agent => ({ agent })) }),
      create: async input => { if (failCreate) throw new Error('provider unavailable'); const id = `successor-${created.length + 1}`; created.push(input.config); agents.push({ ...agents[0]!, id, provider: input.config.provider, labels: input.labels ?? {}, archivedAt: null }); return { id }; },
      ref: id => ({ send: async text => { if (failSend && id.startsWith('successor')) throw new Error('send unavailable'); sent.push({ id, text }); }, archive: async () => { archived.push(id); agents.find(a => a.id === id)!.archivedAt = new Date().toISOString(); return { archivedAt: new Date().toISOString() }; }, timeline: { refetch: async () => ({ entries: [] }) } }),
    },
    providers: { listAvailable: async () => ({ providers: [{ provider: 'pi', available: true }, { provider: 'claude', available: true }] }), listModels: async () => ({ models: [] }) },
  };
  const surface = createSurfaceHandlers({ factory, stateDir, home: dir, daemon, handoff: input => runtime.handoff(input), stopAgent: async id => { stopped.push(id); return { ok: true }; } });
  const makeRuntime = () => createLeadMailRuntime({ factory, stateDir, daemon, home: dir, ensureLead: input => surface.leadEnsure(input), retireLead: input => surface.leadRotate(input), ownerHandoffTimeoutMs: options.timeout ?? 10000, stopAgent: async id => { stopped.push(id); return { ok: true }; } });
  let runtime = makeRuntime();
  t.after(() => runtime.stop());
  return { ...project, stateDir, surface, get runtime() { return runtime; }, restart() { runtime.stop(); runtime = makeRuntime(); runtime.startupRecovery(); }, sent, archived, stopped, created, agents, factory, mailbox: () => readLeadMailbox(join(projectStateDir(stateDir, project.slug), 'mailbox.jsonl')), failCreate: (value: boolean) => { failCreate = value; }, failSend: (value: boolean) => { failSend = value; } };
}

test('Supervisor provider handoff carries Owner goals and held reports into its successor while the Lead keeps working', async t => {
  const f = fixture(t);
  const changed = await f.surface.lanesSet({ projectRoot: f.root, lane: 'supervisor', value: 'claude/opus-4-8' }); assert.equal(changed.ok, true);
  assert.equal(f.created.length, 0);
  assert.match(f.sent[0]?.text ?? '', /Owner goals[\s\S]*decisions taken[\s\S]*open questions/i);
  const report = await f.runtime.reportSupervisor({ id: 'report', kind: 'supervisor_report', project: f.slug, message: 'Wave is ready' }); assert.equal(report.ok, true);
  assert.equal(f.mailbox().supervisorQueued.length, 1);
  await f.runtime.onLeadTurnEnded({ agentId: 'old', outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text: '## Owner goals\nShip safely\n## Decisions taken\nUse new lane\n## Open questions\nNone' }] });
  assert.equal(f.created[0]?.provider, 'claude/opus-4-8');
  const kickoff = f.sent.find(s => s.id === 'successor-1')!.text;
  assert.match(kickoff, /seat kickoff packet/); assert.match(kickoff, /Ship safely/); assert.match(kickoff, /live Lead: lead/i); assert.match(kickoff, /Held reports: 1/); assert.match(kickoff, /Wave is ready/);
  assert.ok(kickoff.indexOf('Ship safely') < kickoff.indexOf('Wave is ready'));
  assert.deepEqual(f.archived, ['old']); assert.deepEqual(f.stopped, ['old']); assert.equal(f.sent.some(s => s.id === 'lead'), false);
  assert.equal(f.mailbox().supervisorInFlight?.toAgentId, 'successor-1');
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.supervisor, 'successor-1');
  assert.match(readFileSync(join(projectStateDir(f.stateDir, f.slug), 'supervisor-handoff.md'), 'utf8'), /Ship safely/);
});

test('legacy Supervisor revoke RPC starts a continuity handoff instead of retiring the chat', async t => {
  const f = fixture(t);
  const { registerSurfaceRpc } = await import('../plugin/server/surface-rpc.ts');
  let revoke: ((input: { projectRoot: string }, context: unknown) => Promise<unknown>) | undefined;
  registerSurfaceRpc({ handle: (rpc: { name: string }, handler: typeof revoke) => { if (rpc.name === 'factory.supervisor.revoke') revoke = handler; } } as never, f.surface);
  assert.ok(revoke); await revoke({ projectRoot: f.root }, {});
  assert.deepEqual(f.archived, []);
  assert.match(f.sent[0]?.text ?? '', /Owner goals/);
});

test('Supervisor near its mark raises a Hand off now suggestion without creating a successor', async t => {
  const f = fixture(t);
  f.agents[0]!.lastUsage = { contextWindowUsedTokens: 83200, contextWindowMaxTokens: 128000 };
  await f.runtime.pumpAll();
  const snapshot = await f.surface.snapshot({ projectRoot: f.root }); assert.ok(snapshot.ok);
  const suggestion = snapshot.view.panel?.needsYou.find(item => item.kind === 'supervisor-near-mark');
  assert.ok(suggestion); assert.equal(suggestion.action.kind, 'handoff-supervisor'); assert.equal(suggestion.action.label, 'Hand off now');
  assert.equal(f.created.length, 0); assert.deepEqual(f.archived, []);
});

test('Supervisor ensure cannot bypass an in-flight provider handoff', async t => {
  const f = fixture(t);
  await f.surface.lanesSet({ projectRoot: f.root, lane: 'supervisor', value: 'claude/opus-4-8' });
  const ensured = await f.surface.supervisorEnsure({ projectRoot: f.root });
  assert.equal(ensured.ok, false); assert.deepEqual(f.archived, []); assert.equal(f.created.length, 0);
});

test('Replace now uses a bounded substitute and releases a Supervisor with a parented live Lead', async t => {
  const f = fixture(t, { parented: true });
  const started = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'start'); assert.ok(started.ok); assert.equal(started.progress?.state, 'handing-over');
  const replaced = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'replaceNow'); assert.ok(replaced.ok); assert.equal(replaced.progress?.state, 'done'); assert.equal(replaced.progress?.handover, 'substitute');
  const handover = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'handover'); assert.ok(handover.ok); assert.equal(handover.source, 'substitute');
  assert.ok(Buffer.byteLength(handover.text!) <= 4096);
  for (const section of ['Plugin-built handover', 'Ledger digest', 'Project notebook', 'Git state', 'Open Tasks', 'Recent timeline']) assert.ok(handover.text!.includes(section));
  assert.deepEqual(f.archived, []); assert.deepEqual(f.stopped, []); assert.equal(f.sent.some(s => s.id === 'lead'), false);
  assert.equal(readProjectRegistration(f.stateDir, f.slug)?.releasedSupervisors?.[0]?.waitingOnLead, 'lead');
  assert.match(f.sent.find(s => s.id === 'old' && /successor-1/.test(s.text))?.text ?? '', /successor-1/);
});

test('successor creation failure holds queued and unacknowledged reports until Try again succeeds with the stored handover', async t => {
  const f = fixture(t);
  await f.runtime.reportSupervisor({ id: 'first', kind: 'supervisor_report', project: f.slug, message: 'Unacknowledged report' });
  assert.equal(f.mailbox().supervisorInFlight?.toAgentId, 'old');
  f.failCreate(true);
  const failed = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'replaceNow'); assert.ok(failed.ok); assert.equal(failed.progress?.state, 'failed');
  await f.runtime.reportSupervisor({ id: 'second', kind: 'supervisor_report', project: f.slug, message: 'Held after create failure' });
  assert.equal(f.created.length, 0); assert.deepEqual(f.archived, []);
  const before = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'handover'); assert.ok(before.ok);
  f.failCreate(false);
  const retry = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'retry'); assert.ok(retry.ok); assert.equal(retry.progress?.state, 'done');
  const kickoff = f.sent.find(s => s.id === 'successor-1')!.text;
  assert.ok(kickoff.includes(before.text!)); assert.match(kickoff, /Held reports: 2/); assert.match(kickoff, /Unacknowledged report/); assert.match(kickoff, /Held after create failure/);
  assert.equal(f.mailbox().supervisorInFlight?.items.length, 2); assert.equal(f.mailbox().supervisorQueued.length, 0); assert.equal(f.sent.some(s => s.id === 'lead'), false);
});

test('no extraction reply falls back once within the Owner window', async t => {
  const f = fixture(t, { timeout: 20 });
  const started = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'start'); assert.ok(started.ok); assert.equal(started.progress?.state, 'handing-over');
  const deadline = Date.now() + 2000;
  while (!f.created.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.created.length, 1);
  const handover = await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'handover'); assert.ok(handover.ok); assert.equal(handover.progress?.state, 'done'); assert.equal(handover.source, 'substitute');
  assert.equal(f.sent.filter(s => s.id === 'old' && /reply first/.test(s.text)).length, 1);
});

test('a failed successor kickoff survives restart and resumes with the same successor and held reports', async t => {
  const f = fixture(t);
  await f.surface.handoff({ projectRoot: f.root, seat: 'supervisor' }, 'start');
  await f.runtime.reportSupervisor({ id: 'held', kind: 'supervisor_report', project: f.slug, message: 'Retain this report' });
  f.failSend(true);
  await f.runtime.onLeadTurnEnded({ agentId: 'old', outcome: { kind: 'completed' }, timeline: [{ type: 'assistant_message', text: '## Owner goals\nResume the same work\n## Decisions taken\nKeep the Lead\n## Open questions\nNone' }] });
  assert.equal(f.created.length, 1); assert.equal(f.sent.some(s => s.id === 'successor-1'), false); assert.equal(f.mailbox().supervisorQueued.length, 1);
  f.restart(); f.failSend(false); await f.runtime.pumpProjectSupervisor(f.slug);
  assert.equal(f.created.length, 1); assert.equal(f.sent.filter(s => s.id === 'successor-1').length, 1);
  assert.match(f.sent.find(s => s.id === 'successor-1')!.text, /Resume the same work[\s\S]*Retain this report/);
  assert.equal(f.mailbox().supervisorInFlight?.toAgentId, 'successor-1'); assert.deepEqual(f.archived, ['old']);
});

test('Supervisor ensure never drops an errored chat history to create a replacement', async t => {
  const f = fixture(t); f.agents[0]!.status = 'error';
  const reply = await f.surface.supervisorEnsure({ projectRoot: f.root });
  assert.equal(reply.ok, false); assert.deepEqual(f.archived, []); assert.equal(f.created.length, 0);
});

test('Lead ensure cannot bypass handoff for an errored standing seat', async t => {
  const f = fixture(t); f.agents.find(agent => agent.id === 'lead')!.status = 'error';
  const reply = await f.surface.leadEnsure({ projectRoot: f.root });
  assert.equal(reply.ok, false); assert.deepEqual(f.archived, []); assert.equal(f.created.length, 0);
});
