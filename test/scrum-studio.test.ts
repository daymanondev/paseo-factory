import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { designFixture } from './fixtures/scrum-design.ts';
import { createFactory } from '../plugin/server/core/factory.ts';
import { resolveProject } from '../plugin/server/core/project.ts';
import { CorrelationRegistry } from '../plugin/server/core/correlations.ts';
import { createSurfaceHandlers } from '../plugin/server/surface-rpc.ts';
import type { SurfaceDaemonApi } from '../plugin/server/surface-rpc.ts';
import { handleSpoolRequest } from '../plugin/server/spool.ts';
import type { ScrumRun } from '../plugin/server/core/scrum/run-journal.ts';

test('the installed Surface returns usable Design Studio URLs and preview content through Owner and Lead ingress', async t => {
  const f = await designFixture(t);
  const submitted = f.submit() as ScrumRun;
  const project = resolveProject(f.root); assert.ok(project.ok);
  cpSync(join(f.state, 'projects/p'), join(f.state, 'projects', project.slug), { recursive: true });
  const factory = createFactory({ stateDir: f.state });
  const daemon = { agents: { list: async () => ({ entries: [], pageInfo: {} }) } } as unknown as SurfaceDaemonApi;
  const handlers = createSurfaceHandlers({ factory, stateDir: f.state, home: f.state, daemon });
  const request = { operation: 'preview.url', runId: submitted.runId, projectRoot: f.root, requestId: 'owner-preview' };
  const opened = await handlers.scrumCommand(request); assert.ok(opened.ok, JSON.stringify(opened));
  const studio = opened.data as { url: string; urls: string[]; digest: string; html: string };
  assert.equal(typeof studio.url, 'string', 'Open Design Studio requires the URL, not a replacement run snapshot');
  assert.ok(studio.urls.includes(studio.url)); assert.equal(studio.digest, f.design.digest);
  const response = await fetch(studio.url); assert.equal(response.status, 200);
  assert.match(await response.text(), /Design overview canvas/);
  const preview = await handlers.scrumCommand({ ...request, operation: 'preview', requestId: 'inline-preview' }); assert.ok(preview.ok);
  assert.match((preview.data as { html: string }).html, /catalog/);
  assert.ok((preview.data as { model: { screens: unknown[] } }).model.screens.length >= 2);
  const lead = new CorrelationRegistry(f.state).issue({ role: 'lead', projectSlug: project.slug, projectRoot: f.root });
  const relayed = await handleSpoolRequest(factory, { id: 'lead-preview', kind: 'scrum_command', operation: 'lead.operation', runId: submitted.runId, requestId: 'lead-preview', projectRoot: f.root, submitter: lead.correlationId, payload: { action: 'preview' } }, {
    scrumCommand: async (input, caller) => {
      const result = await handlers.scrumCommand(input, undefined, caller);
      return result.ok ? { id: input.id, ok: true, summary: 'Studio', data: result.data } : { id: input.id, ok: false, code: result.code, message: result.error };
    },
  });
  assert.ok(relayed.ok, JSON.stringify(relayed));
  assert.equal((relayed.data as { url: string }).url, studio.url);
  const state = await handlers.scrumCommand({ ...request, operation: 'get', requestId: 'state' }); assert.ok(state.ok);
  const run = (state.data as { runs: ScrumRun[] }).runs[0];
  assert.equal(run.revision, submitted.revision); assert.equal(run.design?.decision, undefined);
  assert.equal(run.ownerRequests?.filter(r => r.status === 'pending').length, 1);
});
