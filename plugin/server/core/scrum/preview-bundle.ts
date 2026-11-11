/** A verified Scrum design-approval Studio bundle (removed with Scrum). */
import { previewModel } from './preview-model.ts';
import { designDigest, gitBytes, sha256, verifyRefs } from './artifacts.ts';
import { studioBundle } from '../open-design/preview-bundle.ts';
import type { StudioBundle } from '../open-design/preview-bundle.ts';
import type { ScrumRun } from './run-journal.ts';
export type { StudioBundle };
export function previewBundle(root: string, run: ScrumRun): StudioBundle {
  if (!run.design || designDigest(run.design.refs) !== run.design.digest) throw new Error('No current submitted design');
  verifyRefs(root, run.design.refs, run.ownedPaths);
  const prefix = `.scratch/${run.initiativeId}/`; const files: Record<string, string> = {};
  for (const ref of [...run.design.refs, ...run.design.browserEvidence]) {
    const bytes = gitBytes(root, 'show', `${ref.commit}:${ref.path}`);
    if (sha256(bytes) !== ref.sha256) throw new Error(`Stale design artifact: ${ref.path}`);
    files[ref.path.startsWith(prefix) ? ref.path.slice(prefix.length) : ref.path] = bytes.toString('base64');
  }
  return studioBundle(files, previewModel(root, run), run.ownerRequests?.find(r => r.status === 'pending' && r.kind === 'design')?.id ?? `${run.runId}:${run.design.digest}`);
}
