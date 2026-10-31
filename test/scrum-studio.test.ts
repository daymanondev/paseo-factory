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

test('Surface Studio serves the committed Open Design flow board, scripts and frames with token protection and offline CSP', async t => {
  const { openDesignFiles } = await import('./fixtures/open-design.ts');
  const { stageOpenDesignFrames } = await import('../src/scrum/open-design.ts');
  const { makeTempDir, disposeDir } = await import('./helpers.ts');
  const { readFileSync } = await import('node:fs');
  const files = openDesignFiles();
  const temp = makeTempDir(); disposeDir(t, temp); stageOpenDesignFrames(temp);
  for (const name of ['iphone.html', 'android.html', 'neutral.html']) files['mockups/.od-frames/' + name] = readFileSync(join(temp, '.od-frames', name), 'utf8');
  files['mockups/index.html'] = files['mockups/index.html'].replace('</body>', '<a href="index.html?screen=checkout">Checkout</a></body>');
  files['mockups/styles.css'] += '\n@import "theme.css";';
  files['mockups/theme.css'] = 'body { margin: 0 }';
  const report = JSON.parse(files['mockups/browser.json']);
  report.viewports.forEach((v: {screenshot:{path:string}}) => v.screenshot.path = '.scratch/studio/' + v.screenshot.path);
  const f = await designFixture(t, r => Object.assign(r, report), files);
  const submitted = f.submit() as ScrumRun;
  const project = resolveProject(f.root); assert.ok(project.ok);
  cpSync(join(f.state, 'projects/p'), join(f.state, 'projects', project.slug), { recursive: true });
  const factory = createFactory({ stateDir: f.state });
  const daemon = { agents: { list: async () => ({ entries: [], pageInfo: {} }) } } as unknown as SurfaceDaemonApi;
  const handlers = createSurfaceHandlers({ factory, stateDir: f.state, home: f.state, daemon });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = await handlers.scrumCommand({ operation: 'preview.url', runId: submitted.runId, projectRoot: f.root, requestId: 'od-preview' });
  assert.ok(opened.ok, JSON.stringify(opened));
  const studio = opened.data as {url:string};
  const html = await (await fetch(studio.url)).text();
  assert.match(html, /Flow Board/); assert.match(html, /Interactive Handset/);
  for (const name of ['screens.html', 'screens.css', 'screens-data.js', 'styles.css', 'app.js', 'design-manifest.json', '.od-frames/iphone.html', '.od-frames/layout.css']) {
    const url = new URL(studio.url); url.pathname = '/mockups/' + name;
    const response = await fetch(url); assert.equal(response.status, 200, name);
    if (name.endsWith('.html')) {
      assert.match(response.headers.get('content-security-policy')!, /connect-src 'none'/);
      assert.match(response.headers.get('content-security-policy')!, /script-src 'unsafe-inline' 'self'/);
    }
    url.search = ''; assert.equal((await fetch(url)).status, 403, name + ' unauthorized');
  }
  const cssUrl = new URL(studio.url); cssUrl.pathname = '/mockups/styles.css';
  const css = await fetch(cssUrl);
  const inherited = new URL('theme.css', css.url);
  assert.equal(inherited.searchParams.get('token'), null, 'relative assets inherit the session from the URL path');
  assert.equal((await fetch(inherited)).status, 200, 'quoted CSS imports and JS-created assets retain authorization');
  assert.equal((await fetch(new URL('index.html?screen=checkout', css.url))).status, 200, 'prototype query navigation remains usable');
  t.mock.timers.tick(23 * 60 * 60_000);
  assert.equal((await fetch(studio.url)).status, 200, 'preview survives the former fifteen-minute expiry');
  t.mock.timers.tick(2 * 60 * 60_000);
  assert.equal((await fetch(studio.url)).status, 200, 'requests refresh the twenty-four-hour idle lifetime');
  t.mock.timers.tick(24 * 60 * 60_000 + 1);
  await assert.rejects(fetch(studio.url), /fetch failed/);
});
