/** A verified, self-contained Studio document for an opaque client frame (linked Open Design only). */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { designStudioHtml } from './design-studio.ts';
import { readOpenDesignLink, readOpenDesignFiles } from './open-design-link.ts';
import { DESIGN_STATES, designTokens } from './design-vocab.ts';
import type { DesignScreen, DesignTokens } from './design-vocab.ts';
/** The Studio's read model; a linked design fills it from the synced bundle, never from run state. */
export interface StudioModel {
  flowBoard: boolean; frames: string[]; runId: string; initiativeId: string; revision: number;
  design: { revision: number; digest: string; refs: unknown[]; browserEvidence: unknown[] };
  screens: DesignScreen[]; states: readonly string[];
  documents: { design: string; experience: string; context: string };
  tokens: DesignTokens; evidence: unknown;
}
export interface StudioBundle {
  studioHtml: string; files: Record<string, string>; model: StudioModel;
  activeGateId: string | null; channel: string;
}
export function linkedPreviewBundle(root: string): StudioBundle {
  const link = readOpenDesignLink(root); if (!link) throw new Error('Link an Open Design project first');
  const files = Object.fromEntries(readOpenDesignFiles(join(root, 'design')).map(f => ['mockups/' + f.path, f.contentBase64]));
  const read = (name: string) => files['mockups/' + name] ? Buffer.from(files['mockups/' + name], 'base64').toString() : '';
  const manifest = JSON.parse(read('design-manifest.json') || '{}');
  const documents = { design: read('DESIGN.md') || read('styles.css'), experience: read('EXPERIENCE.md'), context: read('design-manifest.json') };
  const screens = Array.isArray(manifest.screens) && manifest.screens.length ? manifest.screens.map((s: { id: string; title?: string; surface?: string }) => ({ ...s, surface: s.surface ?? 'responsive', body: '', line: 1 })) : [{ id: 'preview', title: link.projectName, surface: 'responsive', body: '', line: 1 }];
  const model = { flowBoard: !!files['mockups/screens.html'], frames: ['iphone', 'android', 'neutral'], runId: link.projectName, initiativeId: 'linked-design', revision: 0, design: { revision: 0, digest: link.digest, refs: [], browserEvidence: [] }, screens, states: DESIGN_STATES, documents, tokens: designTokens(documents.design + '\n' + documents.context), evidence: { network: 'disabled', consoleErrors: [], pageErrors: [], viewports: [], states: [] } } as unknown as StudioModel;
  return studioBundle(files, model, null);
}
export function studioBundle(files: Record<string, string>, model: StudioModel, activeGateId: string | null): StudioBundle {
  const channel = randomUUID();
  const data = JSON.stringify({ files, model, activeGateId, channel }).replace(/</g, '\\u003c');
  const bootstrap = `<script>(${relayRuntime.toString()})(${data});</script>`;
  return { files, model, activeGateId, channel, studioHtml: designStudioHtml().replace('<script>', bootstrap + '<script>') };
}
/** Serialized into Studio; keep dependency-free. Mockups remain in separate opaque sandboxes. */
function relayRuntime(bundle: { files: Record<string, string>; model: unknown; activeGateId: string | null; channel: string }) {
  const mime = (p: string) => ({ css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', html: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json', woff: 'font/woff', woff2: 'font/woff2' }[p.split('.').pop()!] ?? 'application/octet-stream');
  const urls = new Map<string, string>();
  const bytes = (p: string) => Uint8Array.from(atob(bundle.files[p]), c => c.charCodeAt(0));
  const text = (p: string) => new TextDecoder().decode(bytes(p));
  const resolve = (asset: string, base: string) => new URL(asset, 'https://factory.invalid/' + base);
  const resource = (path: string, query = '', stack: string[] = []): string => {
    const key = path + query; if (urls.has(key)) return urls.get(key)!;
    if (!bundle.files[path] || stack.includes(path)) return 'data:text/plain,Unavailable';
    const type = mime(path); let body: Uint8Array | string = bytes(path);
    if (/text\//.test(type)) {
      let content = text(path); const next = [...stack, path];
      const asset = (value: string) => {
        if (/^(?:data:|blob:|#)/.test(value)) return value;
        const target = resolve(value, path); const name = decodeURIComponent(target.pathname.slice(1));
        if (target.origin !== 'https://factory.invalid' || !bundle.files[name]) return 'data:text/plain,Unavailable';
        return resource(name, target.search || (name.endsWith('.js') || name.endsWith('.mjs') ? query : ''), next) + target.hash;
      };
      if (type === 'text/css') content = content.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/g, (_, _q, value) => 'url("' + asset(value) + '")').replace(/@import\s+(["'])([^"']+)\1/g, (_, _q, value) => '@import "' + asset(value) + '"');
      if (type === 'text/javascript') content = content.replace(/(?:window\.)?location.search/g, JSON.stringify(query));
      if (type === 'text/html') {
        content = content.replace(/(?:window\.)?location.search/g, JSON.stringify(query)).replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (_, attr, quote, value) => { const target = resolve(value, path); const sameDocument = attr.toLowerCase() === 'href' && target.origin === 'https://factory.invalid' && target.pathname.slice(1) === path && target.search; return attr + '=' + quote + (sameDocument ? '#factory-route=' + encodeURIComponent(target.search) : asset(value)) + quote; });
        const route = Object.fromEntries(new URLSearchParams(query));
        const init = '<script>(()=>{const route=' + JSON.stringify(route).replace(/</g, '\\u003c') + ';let pick=false;function apply(){Object.assign(document.documentElement.dataset,route);dispatchEvent(new MessageEvent("message",{data:{type:"scrum:set-state",...route}}))}addEventListener("DOMContentLoaded",apply);addEventListener("load",apply);addEventListener("message",e=>{if(e.source!==parent)return;if(e.data?.type==="scrum:pick-mode")pick=e.data.enabled;if(e.data?.type==="scrum:set-state")Object.assign(document.documentElement.dataset,e.data)});document.addEventListener("click",e=>{const anchor=e.target.closest?.("a[href]");if(!pick&&anchor?.hash.startsWith("#factory-route=")){e.preventDefault();Object.assign(route,Object.fromEntries(new URLSearchParams(decodeURIComponent(anchor.hash.slice(15)))));apply();return}if(!pick)return;e.preventDefault();e.stopImmediatePropagation();const el=e.target;if(!(el instanceof Element))return;parent.postMessage({type:"scrum:element-picked",screen:document.documentElement.dataset.screen,state:document.documentElement.dataset.state,selector:el.id?"#"+CSS.escape(el.id):el.tagName.toLowerCase(),label:(el.textContent||"").slice(0,120)},"*")},true)})();<\/script>';
        const csp = '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' data: blob:; style-src \'unsafe-inline\' data: blob:; img-src data: blob:; font-src data: blob:; frame-src data: blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'">';
        content = csp + init + content;
      }
      body = content;
    }
    const encoded = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    let binary = ''; for (let i = 0; i < encoded.length; i += 8192) binary += String.fromCharCode(...encoded.subarray(i, i + 8192));
    const url = 'data:' + type + ';base64,' + btoa(binary); urls.set(key, url); return url;
  };
  const pending = new Map<string, { resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout> }>();
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (String(input) !== 'https://factory.invalid/api/decision') return originalFetch(input, init);
    if (!bundle.activeGateId) return new Response(JSON.stringify({ error: 'This linked design has no active approval gate.' }), { status: 409 });
    const id = Math.random().toString(36).slice(2);
    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(new Response(JSON.stringify({ error: 'Paseo decision timed out. Reopen Studio and try again.' }), { status: 504 })); }, 30000);
      pending.set(id, { resolve, timer });
      parent.postMessage({ type: 'factory:studio-decision', channel: bundle.channel, id, activeGateId: bundle.activeGateId, decision: JSON.parse(String(init?.body ?? '{}')) }, '*');
    });
  };
  addEventListener('message', e => {
    if (e.source !== parent || e.data?.type !== 'factory:studio-result' || e.data.channel !== bundle.channel) return;
    const request = pending.get(e.data.id); if (!request) return; clearTimeout(request.timer); pending.delete(e.data.id);
    request.resolve(new Response(JSON.stringify(e.data.ok ? e.data.data ?? {} : { error: e.data.error }), { status: e.data.ok ? 200 : 409 }));
  });
  (window as unknown as { __factoryBundle: unknown }).__factoryBundle = { endpoint(path: string, params: Record<string, string> = {}) {
    if (path === '/api/state') return 'data:application/json,' + encodeURIComponent(JSON.stringify(bundle.model));
    if (path === '/api/decision') return 'https://factory.invalid/api/decision';
    if (path === '/asset') { const suffix = params.path.replace(/^\.scratch\/[^/]+\//, ''); return resource(suffix); }
    return resource(path === '/mockup' ? 'mockups/index.html' : path.replace(/^\//, ''), '?' + new URLSearchParams(params).toString());
  } };
  if (!bundle.activeGateId) addEventListener('DOMContentLoaded', () => { document.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(b => { b.disabled = true; b.title = 'No active Scrum approval gate'; }); });

}
