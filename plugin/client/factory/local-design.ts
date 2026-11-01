import { readLocalCatalogMetadata } from './local-design-catalog.ts';
/** Browser-granted local folders let a Desktop client push designs to a remote host. */
import type { z } from 'zod';
import type { openDesignSync } from '../../shared/rpc.ts';
export type DesignBundleInput = NonNullable<z.input<typeof openDesignSync.input>['bundle']>;
export interface DesignDirectory {
  name: string;
  values(): AsyncIterable<DesignDirectory | DesignFile>;
  kind: 'directory';
  getFileHandle(name: string): Promise<DesignFile>;
  getDirectoryHandle(name: string): Promise<DesignDirectory>;
  queryPermission(options: { mode: 'read' }): Promise<string>;
}
interface DesignFile { name: string; kind: 'file'; getFile(): Promise<File> }
const supported = /\.(?:html|css|js|mjs|json|md|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|avif|mp4|webm)$/i;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const hash = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
export async function readLocalDesign(directory: DesignDirectory): Promise<DesignBundleInput> {
  const files: DesignBundleInput['files'] = []; let updatedAt = 0, total = 0;
  const visit = async (dir: DesignDirectory, prefix: string) => {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith('.') && entry.name !== '.od-frames') continue;
      const path = prefix + entry.name;
      if (entry.kind === 'directory') { await visit(entry, path + '/'); continue; }
      if (!supported.test(path) || entry.name === 'open-design-link.json') continue;
      const file = await entry.getFile(); total += file.size; if (total > 64 * 1024 * 1024 || files.length >= 5000) throw new Error('Select a design project folder under 64 MiB.');
      updatedAt = Math.max(updatedAt, file.lastModified);
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      files.push({ path, contentBase64: btoa(binary) });
    }
  };
  await visit(directory, '');
  if (!files.some(f => f.path === 'index.html' || f.path === 'screens.html')) throw new Error('Choose the Open Design project folder containing index.html or screens.html.');
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const parts = await Promise.all(files.map(async f => f.path + '\0' + await hash(Uint8Array.from(atob(f.contentBase64), c => c.charCodeAt(0))) + '\n'));
  const digest = await hash(new TextEncoder().encode(parts.join('')));
  const read = (name: string) => { const file = files.find(f => f.path === name); return file ? new TextDecoder().decode(Uint8Array.from(atob(file.contentBase64), c => c.charCodeAt(0))) : ''; };
  const html = new DOMParser().parseFromString(read('screens.html') || read('index.html'), 'text/html');
  let manifest: { directionId?: string; designSystemId?: string } = {}; try { manifest = JSON.parse(read('design-manifest.json') || '{}'); } catch { /* synthesized on receiving host */ }
  const ids = new Set([...html.querySelectorAll('[data-screen],[data-screen-id]')].map(el => el.getAttribute('data-screen') ?? el.getAttribute('data-screen-id')));
  for (const match of (read('screens.html') || read('index.html')).matchAll(/[?&](?:amp;)?screen=([a-zA-Z0-9_-]+)/g)) ids.add(match[1]);
  return { project: { projectId: directory.name.replace(/[^a-zA-Z0-9_-]/g, '-'), projectName: html.title || directory.name, directionId: manifest.directionId, designSystemId: manifest.designSystemId, sourceUpdatedAt: updatedAt, digest, screenCount: ids.size }, files };
}
/** Handles survive reloads, but access is queried without prompting during background sync. */
export async function designDirectoryStore(key: string, value?: DesignDirectory | null): Promise<DesignDirectory | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('factory-open-design', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('folders');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('folders', value === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('folders'); const operation = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
      let result: DesignDirectory | undefined;
      operation.onsuccess = () => { result = value === undefined ? operation.result as DesignDirectory | undefined : value ?? undefined; };
      tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

export async function readLocalDesignCatalog(directory: DesignDirectory) {
  const metadata = await readLocalCatalogMetadata(directory).catch(() => []);
  const projects = await directory.getDirectoryHandle('projects');
  const result: Array<{ directory: DesignDirectory; bundle: DesignBundleInput }> = [];
  for await (const entry of projects.values()) {
    if (entry.kind !== 'directory') continue;
    try { const bundle = await readLocalDesign(entry); const row = metadata.find(r => r.projectId === entry.name); if (row) bundle.project = { ...bundle.project, ...row }; result.push({ directory: entry, bundle }); }
    catch { /* Non-project folders do not hide the remaining catalog. */ }
  }
  return result.sort((a,b) => b.bundle.project.sourceUpdatedAt - a.bundle.project.sourceUpdatedAt);
}
export async function readGrantedDesign(directory: DesignDirectory): Promise<DesignBundleInput> {
  const bundle = await readLocalDesign(directory);
  const catalog = await designDirectoryStore('catalog');
  if (catalog && await catalog.queryPermission({ mode: 'read' }) === 'granted') {
    const row = (await readLocalCatalogMetadata(catalog).catch(() => [])).find(r => r.projectId === directory.name);
    if (row) bundle.project = { ...bundle.project, ...row };
  }
  return bundle;
}
