import { gitBytes } from './artifacts.ts';
import { designScreens, designTokens, DESIGN_STATES } from './design-contract.ts';
import type { BrowserEvidenceReport } from './design-contract.ts';
import type { ScrumRun } from './run-journal.ts';
/** Build exclusively from the submitted blobs, never a mutable working tree. */
export function previewModel(root: string, run: ScrumRun) {
  const design = run.design!;
  const refs = [...design.refs, ...design.browserEvidence];
  const read = (suffix: string) => { const ref = refs.find(r => r.path.endsWith('/' + suffix)); return ref ? gitBytes(root, 'show', `${ref.commit}:${ref.path}`).toString() : ''; };
  const evidence = JSON.parse(read('mockups/browser.json') || gitBytes(root, 'show', `${design.browserEvidence[0].commit}:${design.browserEvidence[0].path}`).toString()) as BrowserEvidenceReport;
  const documents = { design: read('DESIGN.md'), experience: read('EXPERIENCE.md'), context: read('impeccable.local.md') || read('.impeccable.md') };
  const declared = designScreens(documents.experience, read('mockups/manifest.json'));
  const screens: import('./design-contract.ts').DesignScreen[] = declared.length ? declared : [...new Set(evidence.states.map(s => s.screen))].map(id => ({ id, body: '', line: 1 }));
  return { runId: run.runId, initiativeId: run.initiativeId, revision: run.revision, design, screens, states: DESIGN_STATES, documents, tokens: designTokens(documents.design + '\n' + documents.context), evidence };
}
