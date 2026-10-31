/** Token-bound studio server (loopback + Tailscale/LAN host IPs for remote Paseo Desktop clients). */
import { posix } from 'node:path';
import { offlineAssetPath } from './open-design-lint.ts';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { FactoryError } from '../errors.ts';
import { renderPreview } from './preview.ts';
import { previewModel } from './preview-model.ts';
import { previewBridge, injectPreviewBridge } from './preview-bridge.ts';
import { designStudioHtml } from './design-studio.ts';
import { gitBytes, sha256 } from './artifacts.ts';
import { DESIGN_STATES } from './design-contract.ts';
import type { ScrumRun } from './run-journal.ts';
import type { ScrumDesignFinding, ScreenStatuses } from './design-contract.ts';
export interface PreviewDecision {
  revision: number; digest: string; decision: 'approved' | 'changes_requested' | 'waived'; rationale: string;
  findings?: ScrumDesignFinding[]; screenStatuses?: ScreenStatuses;
}
const previews = new Map<string, { server: Server; url: string; urls: string[]; fingerprint: string }>();
export const PREVIEW_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const mockupCsp = "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

function listReachableHostIps(): string[] {
  const tailscale: string[] = [];
  const lan: string[] = [];
  const other: string[] = [];
  try {
    const nets = networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries ?? []) {
        if (net.internal || net.family !== 'IPv4' || !net.address) continue;
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(net.address)) {
          tailscale.push(net.address);
        } else if (
          /^192\.168\./.test(net.address) ||
          /^10\./.test(net.address) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(net.address)
        ) {
          lan.push(net.address);
        } else {
          other.push(net.address);
        }
      }
    }
  } catch {
    // ignore interface enumeration errors
  }
  return [...new Set([...tailscale, ...lan, ...other])];
}

export async function servePreview(root: string, run: ScrumRun, options: { subpath?: string; port?: number; decide?: (input: PreviewDecision) => ScrumRun | Promise<ScrumRun>; current?: () => ScrumRun } = {}) {
  const preview = renderPreview(root, run, options.subpath);
  const model = previewModel(root, run);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FactoryError('invalid-preview-port', 'port must be 0..65535');
  const key = `${root}:${run.runId}`, fingerprint = `${preview.digest}:${run.revision}:${options.subpath ?? ''}:${port}`;
  const existing = previews.get(key);
  if (existing?.fingerprint === fingerprint) return { ...preview, url: existing.url, urls: existing.urls };
  if (existing) { existing.server.close(); previews.delete(key); }
  const token = randomBytes(32).toString('hex');
  let origin = '', decided = false, deciding = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => { clearTimeout(expiry); expiry = setTimeout(() => { if (previews.get(key)?.server === server) previews.delete(key); server.close(); }, PREVIEW_IDLE_TIMEOUT_MS); expiry.unref(); };
  const prefix = `.scratch/${run.initiativeId}/`;
  const mockupRef = (path: string) => run.design!.refs.find(r => r.path === prefix + path);
  const readAsset = (path: string) => {
    const ref = mockupRef(path);
    if (!ref) throw new FactoryError('preview-missing-asset', path);
    const bytes = gitBytes(root, 'show', `${ref.commit}:${ref.path}`);
    if (sha256(bytes) !== ref.sha256) throw new FactoryError('stale-artifact-ref', ref.path);
    return bytes;
  };
  const assetUrl = (path: string, reference: string) => {
    const target = offlineAssetPath(path, reference);
    if (!target) return reference;
    const suffix = reference.includes('?') ? reference.slice(reference.indexOf('?')) : reference.includes('#') ? reference.slice(reference.indexOf('#')) : '';
    const url = new URL('/' + target + suffix, 'http://localhost'); url.searchParams.set('token', token);
    return url.pathname + url.search + url.hash;
  };
  const rewrite = (path: string, source: string) => {
    let result = path.endsWith('.html') ? source.replace(/\b(src|href|poster)\s*=\s*(["'])([^"']+)\2/gi, (_, attr, quote, ref) => `${attr}=${quote}${assetUrl(path, ref)}${quote}`) : source;
    if (/\.(?:html|css)$/.test(path)) result = result.replace(/url\(\s*(["']?)([^\s"'\)]+)\1\s*\)/gi, (_, quote, ref) => `url(${quote}${assetUrl(path, ref)}${quote})`);
    return result;
  };
  const allowedHosts = new Set<string>();
  const server = createServer(async (request, response) => {
    refresh();
    const send = (status: number, type: string, body: string | Buffer = '', csp?: string, extraHeaders?: Record<string, string>) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Connection': 'close', ...(csp ? { 'Content-Security-Policy': csp } : {}), ...(extraHeaders ?? {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const json = (status: number, data: unknown, extraHeaders?: Record<string, string>) => send(status, 'application/json', JSON.stringify(data), undefined, extraHeaders);
    try {
      const hostHeader = request.headers.host ?? '';
      const reqOrigin = allowedHosts.has(hostHeader) ? `http://${hostHeader}` : origin;
      const url = new URL(request.url ?? '/', reqOrigin || 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { send(204, 'image/x-icon'); return; }
      if (!allowedHosts.has(hostHeader) || url.searchParams.get('token') !== token) { json(403, { error: 'Invalid preview session token or host' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/decision') {
        const sameOrigin = request.headers.origin === reqOrigin || (!request.headers.origin && request.headers['sec-fetch-site'] === 'same-origin' && request.headers['x-scrum-preview-token'] === token);
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
        json(200, { ...model, currentRevision: current.revision, design: current.design?.digest === preview.digest ? current.design : model.design }, { 'Access-Control-Allow-Origin': '*' }); return;
      }
      if (url.pathname === '/mockup') {
        const screen = url.searchParams.get('screen') ?? model.screens[0]?.id, state = url.searchParams.get('state') ?? 'populated';
        if (!screen || !model.screens.some(s => s.id === screen) || !DESIGN_STATES.includes(state as typeof DESIGN_STATES[number])) { json(400, { error: 'Unknown screen/state' }); return; }
        const bridge = previewBridge(screen, state, url.searchParams.get('viewport') ?? 'desktop');
        send(200, 'text/html; charset=utf-8', injectPreviewBridge(rewrite('mockups/index.html', readAsset('mockups/index.html').toString()), bridge), mockupCsp); return;
      }
      if (url.pathname.startsWith('/mockups/')) {
        const path = decodeURIComponent(url.pathname.slice(1));
        if (!path.startsWith('mockups/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0]/.test(path) || !mockupRef(path)) { json(404, { error: 'Artifact is not in this design' }); return; }
        const bytes = readAsset(path), ext = posix.extname(path);
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
        let body: string | Buffer = ['.html', '.css'].includes(ext) ? rewrite(path, bytes.toString()) : bytes;
        if (path === 'mockups/index.html') body = injectPreviewBridge(String(body), previewBridge(url.searchParams.get('screen') ?? model.screens[0]?.id ?? '', url.searchParams.get('state') ?? 'populated', url.searchParams.get('viewport') ?? 'mobile'));
        if (path === 'mockups/screens.html') body = injectPreviewBridge(String(body), `<script>(()=>{function measure(){let right=640,bottom=480;const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode;if(!n.textContent.trim()||n.parentElement.closest('script,style,[hidden]'))continue;const range=document.createRange();range.selectNodeContents(n);for(const r of range.getClientRects()){right=Math.max(right,r.right+scrollX+40);bottom=Math.max(bottom,r.bottom+scrollY+40)}}for(const el of document.querySelectorAll('iframe,img,svg,canvas,video')){const r=el.getBoundingClientRect();right=Math.max(right,r.right+scrollX+40);bottom=Math.max(bottom,r.bottom+scrollY+40)}parent.postMessage({type:'scrum:flow-size',width:Math.ceil(right),height:Math.ceil(bottom)},'*')}addEventListener('load',measure);new ResizeObserver(measure).observe(document.body)})();</script>`);
        send(200, types[ext] ?? 'application/octet-stream', body, mockupCsp); return;
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.listen(port, '0.0.0.0', () => { server.removeAllListeners('error'); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new FactoryError('preview-unavailable', 'loopback listener unavailable');
  const hostIps = listReachableHostIps();
  for (const h of ['127.0.0.1', 'localhost', ...hostIps]) {
    allowedHosts.add(`${h}:${address.port}`);
  }
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/?token=${token}`;
  const urls = [url, ...hostIps.map(ip => `http://${ip}:${address.port}/?token=${token}`)];
  previews.set(key, { server, url, urls, fingerprint }); server.unref();
  refresh(); server.once('close', () => clearTimeout(expiry));
  return { ...preview, url, urls };
}
