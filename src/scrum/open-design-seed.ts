/**
 * Scrum-only (removed with Scrum): seeds an in-flight Scrum run's workspace
 * `.scratch/<initiative>/mockups` from the Project's linked Open Design bundle.
 * Open Design itself has no notion of runs or initiatives.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FactoryError } from '../errors.ts';
import { readExecution } from './selection.ts';
import { listRuns, terminalRun } from './run-journal.ts';
import { safeId } from '../safe-id.ts';
import { readOpenDesignLink, readOpenDesignFiles, safeDestination } from '../open-design/open-design-link.ts';
const fail = (message: string): never => { throw new FactoryError('open-design-bundle-invalid', message); };
/** Refresh unchanged seeds; a specialist's refinements require explicit reconciliation. */
export function seedLinkedOpenDesign(root: string, workspace: string, initiativeId: string): void {
  if (!safeId(initiativeId)) fail('Invalid initiative id');
  const link = readOpenDesignLink(root); if (!link) return;
  const destination = join(workspace, '.scratch', initiativeId, 'mockups');
  const marker = safeDestination(destination, 'open-design-seed.json', workspace);
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(readFileSync(marker, 'utf8')).files ?? {}; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const next: Record<string, string> = {}; const writes: Array<{ path: string; bytes: Buffer }> = [];
  for (const file of readOpenDesignFiles(join(root, 'design')).filter(f => link.files.includes(f.path))) {
    const path = safeDestination(destination, file.path, workspace), bytes = Buffer.from(file.contentBase64, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex'); next[file.path] = hash;
    if (existsSync(path)) {
      const current = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (current === hash || previous[file.path] === hash) continue;
      if (previous[file.path] !== current) throw new FactoryError('open-design-seed-conflict', `Preserve specialist edits in ${path}; reconcile them with the updated Owner design before dispatch`);
    }
    writes.push({ path, bytes });
  }
  const removals: string[] = [];
  for (const [path, hash] of Object.entries(previous)) if (!(path in next)) { const target = safeDestination(destination, path, workspace); if (existsSync(target)) { if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) throw new FactoryError('open-design-seed-conflict', `Reconcile specialist edits before removing ${target}`); removals.push(target); } }
  for (const path of removals) rmSync(path);
  for (const file of writes) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, file.bytes); }
  mkdirSync(destination, { recursive: true }); writeFileSync(marker, JSON.stringify({ digest: link.digest, files: next }, null, 2) + '\n');
}

/** Seeds every non-terminal Scrum run of a Scrum-mode Project; a no-op for SLP Projects. */
export function seedActiveScrumRuns(state: string, slug: string, root: string): void {
  if (readExecution(state, slug).mode !== 'scrum') return;
  for (const run of listRuns(state, slug).filter(r => !terminalRun(r))) seedLinkedOpenDesign(root, root, run.initiativeId);
}
