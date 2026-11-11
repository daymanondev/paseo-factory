/** Token-bound studio server for a linked Open Design project (loopback + Tailscale/LAN host IPs for remote Paseo Desktop clients). */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { FactoryError } from '../errors.ts';
import { linkedPreviewBundle } from './preview-bundle.ts';
export const previews = new Map<string, { server: Server; url: string; urls: string[]; fingerprint: string }>();
export const PREVIEW_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

export function listReachableHostIps(): string[] {
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

/** Linked pre-run/SLP designs use the same Studio, with approval controls disabled. */
export async function serveLinkedPreview(root: string) {
  const bundle = linkedPreviewBundle(root), key = `${root}:linked`;
  const existing = previews.get(key);
  if (existing?.fingerprint === bundle.model.design.digest) return { url: existing.url, urls: existing.urls };
  existing?.server.close(); previews.delete(key);
  const token = randomBytes(32).toString('hex');
  const port = process.env.PASEO_FACTORY_PREVIEW_PORT ? Number(process.env.PASEO_FACTORY_PREVIEW_PORT) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FactoryError('invalid-preview-port', 'port must be 0..65535');
  const hosts = new Set<string>();
  let expiry: ReturnType<typeof setTimeout>;
  const refresh = () => { clearTimeout(expiry); expiry = setTimeout(() => { server.close(); previews.delete(key); }, PREVIEW_IDLE_TIMEOUT_MS); expiry.unref(); };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!hosts.has(request.headers.host ?? '') || url.searchParams.get('token') !== token) { response.writeHead(403); response.end(); return; }
    refresh();
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
    const health = ['/healthz', '/api/state'].includes(url.pathname);
    response.writeHead(health || url.pathname === '/' ? 200 : 404, { 'Content-Type': health ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : health ? JSON.stringify(bundle.model) : url.pathname === '/' ? bundle.studioHtml : 'Not found');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Preview listener unavailable');
  const urls = ['127.0.0.1', ...listReachableHostIps()].map(ip => { hosts.add(`${ip}:${address.port}`); return `http://${ip}:${address.port}/?token=${token}`; });
  previews.set(key, { server, url: urls[0], urls, fingerprint: bundle.model.design.digest });
  server.unref(); refresh(); server.once('close', () => clearTimeout(expiry));
  return { url: urls[0], urls };
}
