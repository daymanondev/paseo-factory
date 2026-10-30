/** Token-bound loopback studio. The mockup is isolated from all decision authority. */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { FactoryError } from '../errors.ts';
import { renderPreview } from './preview.ts';
import { previewModel } from './preview-model.ts';
import { previewBridge } from './preview-bridge.ts';
import { designStudioHtml } from './design-studio.ts';
import { gitBytes, sha256 } from './artifacts.ts';
import { DESIGN_STATES } from './design-contract.ts';
import type { ScrumRun } from './run-journal.ts';
import type { ScrumDesignFinding, ScreenStatuses } from './design-contract.ts';
export interface PreviewDecision {
  revision: number; digest: string; decision: 'approved' | 'changes_requested' | 'waived'; rationale: string;
  findings?: ScrumDesignFinding[]; screenStatuses?: ScreenStatuses;
}
const previews = new Map<string, { server: Server; url: string; fingerprint: string }>();
const mockupCsp = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob: 'self'; font-src data: 'self'; script-src 'unsafe-inline' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
export async function servePreview(root: string, run: ScrumRun, options: { subpath?: string; port?: number; decide?: (input: PreviewDecision) => ScrumRun | Promise<ScrumRun>; current?: () => ScrumRun } = {}) {
  const preview = renderPreview(root, run, options.subpath);
  const model = previewModel(root, run);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FactoryError('invalid-preview-port', 'port must be 0..65535');
  const key = `${root}:${run.runId}`, fingerprint = `${preview.digest}:${run.revision}:${options.subpath ?? ''}:${port}`;
  const existing = previews.get(key);
  if (existing?.fingerprint === fingerprint) return { ...preview, url: existing.url };
  if (existing) { existing.server.close(); previews.delete(key); }
  const token = randomBytes(32).toString('hex');
  let origin = '', decided = false, deciding = false;
  const server = createServer(async (request, response) => {
    const send = (status: number, type: string, body: string | Buffer = '', csp?: string) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Connection': 'close', ...(csp ? { 'Content-Security-Policy': csp } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const json = (status: number, data: unknown) => send(status, 'application/json', JSON.stringify(data));
    try {
      const url = new URL(request.url ?? '/', origin);
      if (request.headers.host !== new URL(origin).host || url.searchParams.get('token') !== token) { json(403, { error: 'Invalid preview session token or host' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/decision') {
        const sameOrigin = request.headers.origin === origin || (!request.headers.origin && request.headers['sec-fetch-site'] === 'same-origin' && request.headers['x-scrum-preview-token'] === token);
        if (!sameOrigin) { json(403, { error: 'Same-origin Owner decision required' }); return; }
        if (!request.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON required' }); return; }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) { json(413, { error: 'Decision too large' }); return; } chunks.push(Buffer.from(chunk)); }
        let input: PreviewDecision;
        try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { json(400, { error: 'Invalid JSON' }); return; }
        if (!input || input.revision !== preview.revision || input.digest !== preview.digest || decided || deciding) { json(409, { error: 'Design was superseded or already decided; reopen preview' }); return; }
        if (!options.decide) { json(403, { error: 'Owner decision writer unavailable' }); return; }
        deciding = true;
        let updated: ScrumRun;
        try { updated = await options.decide(input); decided = true; } finally { deciding = false; }
        json(200, updated); return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { json(405, { error: 'Method not allowed' }); return; }
      if (url.pathname === '/') { send(200, 'text/html; charset=utf-8', designStudioHtml(), "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"); return; }
      if (url.pathname === '/api/state') {
        const current = options.current?.() ?? run;
        json(200, { ...model, currentRevision: current.revision, design: current.design?.digest === preview.digest ? current.design : model.design }); return;
      }
      if (url.pathname === '/mockup') {
        const screen = url.searchParams.get('screen') ?? model.screens[0]?.id, state = url.searchParams.get('state') ?? 'populated';
        if (!screen || !model.screens.some(s => s.id === screen) || !DESIGN_STATES.includes(state as typeof DESIGN_STATES[number])) { json(400, { error: 'Unknown screen/state' }); return; }
        const bridge = previewBridge(screen, state, url.searchParams.get('viewport') ?? 'desktop');
        send(200, 'text/html; charset=utf-8', preview.html.replace(/<\/body>/i, bridge + '</body>'), mockupCsp); return;
      }
      if (url.pathname === '/asset') {
        const path = url.searchParams.get('path'), ref = [...run.design!.refs, ...run.design!.browserEvidence].find(r => r.path === path);
        if (!ref || !/\.(png|md|json)$/.test(ref.path)) { json(404, { error: 'Artifact is not in this design' }); return; }
        const bytes = gitBytes(root, 'show', `${ref.commit}:${ref.path}`);
        if (sha256(bytes) !== ref.sha256) throw new FactoryError('stale-artifact-ref', ref.path);
        send(200, ref.path.endsWith('.png') ? 'image/png' : ref.path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', bytes); return;
      }
      json(404, { error: 'Unknown preview route' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      json(code === 'run-revision-conflict' || code === 'stale-design-decision' ? 409 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.requestTimeout = 10_000;
  server.on('connection', socket => socket.unref());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new FactoryError('preview-unavailable', 'loopback listener unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/?token=${token}`;
  previews.set(key, { server, url, fingerprint }); server.unref();
  const expiry = setTimeout(() => { if (previews.get(key)?.server === server) previews.delete(key); server.close(); }, 15 * 60_000);
  expiry.unref(); server.once('close', () => clearTimeout(expiry));
  return { ...preview, url };
}
