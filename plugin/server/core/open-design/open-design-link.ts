/** Offline catalog and repository-owned design bundles. No vault or live app dependency. */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { FactoryError } from '../errors.ts';
import { writeDurableFile } from '../history-stage.ts';
import { readProjectSettings, writeProjectSettings } from '../project-settings.ts';
import { stageOpenDesignFrames } from './open-design.ts';
import { safeId } from '../safe-id.ts';
import { readOpenDesignLink, type OpenDesignProjectLink } from './open-design-link-state.ts';
export { readOpenDesignLink, type OpenDesignProjectLink } from './open-design-link-state.ts';

export interface OpenDesignFile { path: string; contentBase64: string }
export interface OpenDesignBundle { project: Omit<OpenDesignProjectLink, 'syncedAt' | 'files'>; files: OpenDesignFile[] }
export interface OpenDesignCatalogProject extends Omit<OpenDesignProjectLink, 'syncedAt'> { hasIndexHtml: boolean; hasScreensHtml: boolean }
const fail = (message: string): never => { throw new FactoryError('open-design-bundle-invalid', message); };
const extensions = /\.(?:html|css|js|mjs|json|md|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|avif|mp4|webm)$/i;
export function openDesignDataDir(userHome = homedir()): string {
  return process.env.OPEN_DESIGN_DATA_DIR ?? join(process.platform === 'win32' ? process.env.APPDATA ?? join(userHome, 'AppData/Roaming') : process.platform === 'darwin' ? join(userHome, 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(userHome, '.config'), 'Open Design/namespaces/release-stable/data');
}
function validPath(path: string): boolean {
  return !!path && !/[\\\0:]/.test(path) && !path.startsWith('/') && path.split('/').every(p => !!p && p !== '.' && p !== '..' && (!p.startsWith('.') || p === '.od-frames')) && extensions.test(path);
}
function inventory(root: string, prefix = ''): OpenDesignFile[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) fail('Bundle directories must not be symlinks');
  return readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = prefix + entry.name;
    if (entry.isSymbolicLink()) fail(`Symlink: ${path}`);
    if (entry.isDirectory()) return entry.name.startsWith('.') && entry.name !== '.od-frames' ? [] : inventory(join(root, entry.name), path + '/');
    return entry.isFile() && validPath(path) && path !== 'open-design-link.json' ? [{ path, contentBase64: readFileSync(join(root, entry.name)).toString('base64') }] : [];
  });
}
function digest(files: OpenDesignFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) hash.update(file.path + '\0' + createHash('sha256').update(Buffer.from(file.contentBase64, 'base64')).digest('hex') + '\n');
  return hash.digest('hex');
}
function screens(files: OpenDesignFile[]): Array<{ id: string; title: string; surface: string }> {
  const source = files.find(f => f.path === 'screens.html') ?? files.find(f => f.path === 'index.html');
  const html = source ? Buffer.from(source.contentBase64, 'base64').toString() : '';
  const found = new Map<string, { id: string; title: string; surface: string }>();
  for (const match of html.matchAll(/<[^>]+\bdata-screen(?:-id)?=["']([^"']+)["'][^>]*>/g)) {
    const id = match[1]; if (!found.has(id)) found.set(id, { id, title: /data-title=["']([^"']+)["']/.exec(match[0])?.[1] ?? id, surface: /data-surface=["'](mobile|desktop|responsive)["']/.exec(match[0])?.[1] ?? 'responsive' });
  }
  // Flow Boards commonly declare screen ids in iframe query strings.
  for (const match of html.matchAll(/[?&](?:amp;)?screen=([a-zA-Z0-9_-]+)/g)) if (!found.has(match[1])) found.set(match[1], { id: match[1], title: match[1], surface: 'responsive' });
  return [...found.values()];
}
function timestamp(value: unknown): number { return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || Date.parse(value) || 0 : 0; }
export function discoverOpenDesignProjects(userHome?: string): OpenDesignCatalogProject[] {
  const data = openDesignDataDir(userHome); let rows: Record<string, unknown>[] = [];
  if (existsSync(join(data, 'app.sqlite'))) {
    let db: DatabaseSync | undefined;
    try {
      const sql = 'SELECT id, name, skill_id, design_system_id, metadata_json, created_at, updated_at, custom_instructions FROM projects ORDER BY updated_at DESC';
      try { const sqlite = createRequire(join(process.cwd(), 'factory-sqlite.cjs'))('node:sqlite') as typeof import('node:sqlite'); db = new sqlite.DatabaseSync(join(data, 'app.sqlite'), { readOnly: true }); rows = db.prepare(sql).all(); }
      catch { rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', join(data, 'app.sqlite'), sql], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '[]'); }
    }
    catch { /* Directory scan remains usable with older or temporarily locked catalogs. */ }
    finally { db?.close(); }
  }
  const dir = join(data, 'projects');
  const ids = new Set([...rows.map(r => String(r.id)), ...(existsSync(dir) ? readdirSync(dir) : [])]);
  return [...ids].filter(id => safeId(id) && existsSync(join(dir, id)) && lstatSync(join(dir, id)).isDirectory()).flatMap(projectId => {
    const row = rows.find(r => r.id === projectId) ?? {}; const files = inventory(join(dir, projectId));
    if (!files.some(f => f.path === 'index.html' || f.path === 'screens.html')) return [];
    let metadata: Record<string, unknown> = {}; try { metadata = JSON.parse(String(row.metadata_json ?? '{}')); } catch { /* optional */ }
    return [{ projectId, projectName: String(row.name ?? projectId), designSystemId: typeof row.design_system_id === 'string' ? row.design_system_id : null, directionId: typeof metadata.directionId === 'string' ? metadata.directionId : typeof row.skill_id === 'string' ? row.skill_id : null, sourceUpdatedAt: timestamp(row.updated_at) || Math.max(...files.map(f => statSync(join(dir, projectId, f.path)).mtimeMs)), digest: digest(files), screenCount: screens(files).length, files: files.map(f => f.path), hasIndexHtml: files.some(f => f.path === 'index.html'), hasScreensHtml: files.some(f => f.path === 'screens.html') }];
  }).sort((a,b) => b.sourceUpdatedAt - a.sourceUpdatedAt);
}
export function exportOpenDesignProject(projectId: string, userHome?: string): OpenDesignBundle {
  const project = discoverOpenDesignProjects(userHome).find(p => p.projectId === projectId);
  if (!project) throw new FactoryError('open-design-project-unavailable', projectId);
  const files = inventory(join(openDesignDataDir(userHome), 'projects', projectId));
  return { project: { ...project, digest: digest(files) }, files };
}
export function safeDestination(root: string, path: string, boundary = dirname(root)): string {
  if (!validPath(path)) fail(`Unsafe path: ${path}`);
  const base = resolve(root);
  const target = join(base, path);
  let current = target;
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) fail(`Symlink destination: ${current}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current || current === resolve(boundary)) break; current = parent;
  }
  return join(base, path);
}
export function syncOpenDesignLink(input: { state: string; slug: string; root: string; projectId?: string; bundle?: OpenDesignBundle; syncRequestId?: string; expectedDigest?: string; userHome?: string}): OpenDesignProjectLink {
  const previous = readOpenDesignLink(input.root);
  if (input.expectedDigest !== undefined && previous?.digest !== input.expectedDigest) throw new FactoryError('open-design-link-changed', 'The design link changed in another window; refresh before syncing');
  const recorded = readProjectSettings(input.state, input.slug);
  if (input.syncRequestId && (recorded.openDesignSource?.requestId !== input.syncRequestId || input.bundle?.project.projectId !== previous?.projectId)) throw new FactoryError('open-design-sync-superseded', 'The requested source sync is no longer current');
  const bundle = input.bundle ?? exportOpenDesignProject(input.projectId ?? previous?.projectId ?? '', input.userHome);
  if (!bundle?.project || !safeId(bundle.project.projectId) || typeof bundle.project.projectName !== 'string' || !Array.isArray(bundle.files) || bundle.files.length > 5000) fail('Invalid bundle metadata');
  let size = 0; const names = new Set<string>(); const dir = join(input.root, 'design');
  for (const f of bundle.files) {
    if (typeof f.path !== 'string' || typeof f.contentBase64 !== 'string' || !validPath(f.path) || f.path === 'open-design-link.json' || names.has(f.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.contentBase64)) fail('Invalid bundle file');
    names.add(f.path); size += Buffer.byteLength(f.contentBase64, 'base64'); if (size > 64 * 1024 * 1024) fail('Bundle exceeds 64 MiB'); safeDestination(dir, f.path);
  }
  if (!names.has('index.html') && !names.has('screens.html')) fail('Bundle needs index.html or screens.html');
  if (digest(bundle.files) !== bundle.project.digest) fail('Bundle digest mismatch');
  const stale = (previous?.files ?? []).filter(p => !names.has(p) && !p.startsWith('.od-frames/') && p !== 'design-manifest.json');
  for (const path of [...stale, 'open-design-link.json', 'design-manifest.json', '.od-frames/iphone.html', '.od-frames/android.html', '.od-frames/neutral.html', '.od-frames/layout.css']) safeDestination(dir, path);
  for (const path of stale) rmSync(join(dir, path), { force: true });
  for (const f of bundle.files) { const target = safeDestination(dir, f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(f.contentBase64, 'base64')); }
  const framePaths = ['iphone.html', 'android.html', 'neutral.html', 'layout.css'].map(p => '.od-frames/' + p);
  const generatedFrames = framePaths.filter(p => !existsSync(join(dir, p)) || (Array.isArray(previous?.files) && previous.files.includes(p)));
  stageOpenDesignFrames(dir);
  if (!names.has('design-manifest.json')) {
    const css = bundle.files.find(f => f.path === 'styles.css'); const text = css ? Buffer.from(css.contentBase64, 'base64').toString() : '';
    const tokens = Object.fromEntries([...text.matchAll(/:root\s*\{([^}]+)\}/g)].flatMap(m => [...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map(t => [t[1], t[2].trim()])));
    writeFileSync(join(dir, 'design-manifest.json'), JSON.stringify({ directionId: bundle.project.directionId, designSystemId: bundle.project.designSystemId, tokens, screens: screens(bundle.files) }, null, 2) + '\n');
  }
  const link: OpenDesignProjectLink = { projectId: bundle.project.projectId, projectName: bundle.project.projectName, designSystemId: bundle.project.designSystemId, directionId: bundle.project.directionId, sourceUpdatedAt: bundle.project.sourceUpdatedAt, digest: bundle.project.digest, screenCount: screens(bundle.files).length, syncedAt: new Date().toISOString(), files: [...new Set([...names, ...generatedFrames, 'design-manifest.json'])].sort() };
  writeDurableFile(join(dir, 'open-design-link.json'), JSON.stringify(link, null, 2) + '\n');
  const settings = readProjectSettings(input.state, input.slug);
  const source = { ...settings.openDesignSource, kind: input.bundle ? 'client' as const : 'host' as const };
  const checkpointPaths = [...new Set([...(settings.openDesignCheckpointPaths ?? []), ...link.files, ...stale, 'open-design-link.json'])];
  writeProjectSettings(input.state, input.slug, { ...settings, openDesignLink: link, openDesignSource: source, openDesignCheckpointPaths: checkpointPaths });
  checkpointLinkedDesign(input.root, checkpointPaths);
  const { openDesignCheckpointPaths: _pending, ...finished } = readProjectSettings(input.state, input.slug);
  writeProjectSettings(input.state, input.slug, { ...finished, ...(input.syncRequestId && source.requestId === input.syncRequestId ? { openDesignSource: { ...source, acknowledgedRequestId: input.syncRequestId } } : {}) });
  return link;
}
export function autoSyncOpenDesignLink(input: { state: string; slug: string; root: string; userHome?: string}): void {
  const link = readOpenDesignLink(input.root) ?? readProjectSettings(input.state, input.slug).openDesignLink; if (!link) return;
  const source = discoverOpenDesignProjects(input.userHome).find(p => p.projectId === link.projectId);
  const hasBundle = existsSync(join(input.root, 'design/index.html')) || existsSync(join(input.root, 'design/screens.html'));
  if (source && (!hasBundle || source.digest !== link.digest || source.sourceUpdatedAt > link.sourceUpdatedAt)) syncOpenDesignLink({ ...input, projectId: link.projectId });
}
/** The synced specification is versioned before a Task can branch from the root. */
function checkpointLinkedDesign(root: string, files: string[]): void {
  for (const file of files) if (!validPath(file)) fail('Unsafe checkpoint path');
  const paths = files.map(p => 'design/' + p);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const existing = paths.filter(p => existsSync(join(root, p))), missing = paths.filter(p => !existsSync(join(root, p)));
    if (existing.length) git('add', '--', ...existing);
    if (missing.length) git('rm', '--cached', '--ignore-unmatch', '--', ...missing);
    if (!git('diff', '--cached', '--name-only', '--', ...paths).trim()) return;
    git('-c', 'user.name=Paseo Factory', '-c', 'user.email=factory@paseo.local', 'commit', '--only', '-m', 'chore(design): sync linked Open Design specification', '--', ...paths);
  } catch { throw new FactoryError('open-design-checkpoint-failed', 'Design files were copied but could not be committed. Resolve repository hooks/index conflicts and sync again before dispatch.'); }
}
/** A client-pushed source must acknowledge a fresh read before mail is queued. */
export async function prepareOpenDesignDispatch(input: { state: string; slug: string; root: string; userHome?: string; timeoutMs?: number; requestId?: string}): Promise<void> {
  const selection = readProjectSettings(input.state, input.slug);
  if (!selection.openDesignLink) return;
  if (selection.openDesignSource?.kind !== 'client') { autoSyncOpenDesignLink(input); const link = readOpenDesignLink(input.root); if (link) { checkpointLinkedDesign(input.root, [...(selection.openDesignCheckpointPaths ?? []), ...link.files, 'open-design-link.json']); } return; }
  const requestId = input.requestId ?? randomUUID();
  if (selection.openDesignSource.acknowledgedRequestId === requestId) return;
  writeProjectSettings(input.state, input.slug, { ...selection, openDesignSource: { ...selection.openDesignSource, requestId } });
  const deadline = Date.now() + (input.timeoutMs ?? 15000);
  while (Date.now() < deadline) {
    const latest = readProjectSettings(input.state, input.slug);
    if (!latest.openDesignLink || latest.openDesignSource?.acknowledgedRequestId === requestId) return;
    if (latest.openDesignSource?.requestId !== requestId) throw new FactoryError('open-design-sync-superseded', 'Another directive requested a newer design sync; retry this directive');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new FactoryError('open-design-client-sync-required', 'Open Factory on the design computer and grant its linked folder access, then retry the directive. No seat mail was queued.');
}
export function unlinkOpenDesign(state: string, slug: string, root: string): void {
  const selection = readProjectSettings(state, slug); const { openDesignLink: _link, openDesignSource: _source, openDesignCheckpointPaths: _pending, ...rest } = selection;
  rmSync(safeDestination(join(root, 'design'), 'open-design-link.json'), { force: true });
  checkpointLinkedDesign(root, [...(selection.openDesignCheckpointPaths ?? []), 'open-design-link.json']);
  writeProjectSettings(state, slug, rest);
}

export { inventory as readOpenDesignFiles };
