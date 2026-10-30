import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommitAll, makeTempDir, disposeDir } from '../helpers.ts';
import type { TestContext } from 'node:test';
import { createFactory } from '../../src/factory.ts';
import { ensureScrumConfig } from '../../src/scrum/config.ts';
import { switchExecution } from '../../src/scrum/execution.ts';
import { createScrumRun, commandRun } from '../../src/scrum/run-journal.ts';
import { artifactAt, designDigest, sha256 } from '../../src/scrum/artifacts.ts';
import { scrumOperation } from '../../src/scrum/controller.ts';
export const states = ['empty', 'loading', 'populated', 'error', 'offline', 'permission-denied'] as const;
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
export const designFiles = {
  'DESIGN.md': '# Tokens\nColor: ink #183153, paper #ffffff\nTypography: Georgia 16px, heading 32px\nSpacing: 8px 16px 24px\nRadius: 4px\nComponent: button uses ink background and paper text\n',
  'EXPERIENCE.md': ['catalog', 'checkout'].map(id => `## Screen: ${id}\n${states.map(s => `${s}: keyboard accessible ${s} content`).join('\n')}`).join('\n'),
  'mockups/index.html': `<!doctype html><html><head><title>Shop</title></head><body><main data-screen="catalog"><button id="buy">Buy</button></main><main data-screen="checkout"><button class="pay-cta">Pay</button></main><script>function route(screen,state){document.documentElement.dataset.screen=screen;document.documentElement.dataset.state=state;document.querySelectorAll('main').forEach(e=>e.hidden=e.dataset.screen!==screen)}const q=new URLSearchParams(location.search);route(q.get('screen')||'catalog',q.get('state')||'populated');window.addEventListener('message',e=>{if(e.data.type==='scrum:set-state')route(e.data.screen,e.data.state)});</script></body></html>`,
};
export async function designFixture(t: TestContext, mutate?: (report: import("../../src/scrum/design-contract.ts").BrowserEvidenceReport) => void) {
  const root = makeTempDir(), state = makeTempDir();
  disposeDir(t, root); disposeDir(t, state);
  const prefix = '.scratch/studio/';
  mkdirSync(join(root, prefix, 'mockups'), { recursive: true });
  for (const [path, content] of Object.entries(designFiles)) writeFileSync(join(root, prefix, path), content);
  const report = {
    network: 'disabled' as const, consoleErrors: [], screens: [{ id: 'catalog' }, { id: 'checkout' }],
    viewports: ['catalog', 'checkout'].flatMap(screen => [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }].map(v => ({ ...v, screen, screenshot: { path: `${prefix}mockups/${screen}-${v.name}.png`, sha256: sha256(png) } }))),
    states: ['catalog', 'checkout'].flatMap(screen => states.map(state => ({ screen, state, keyboard: true, passed: true }))),
    detector: { tool: 'impeccable' as const, passed: true, nonAdvisoryCount: 0, findings: [], viewportsChecked: [{ width: 1280, height: 800, nonAdvisoryCount: 0 }, { width: 390, height: 844, nonAdvisoryCount: 0 }] },
  };
  mutate?.(report);
  for (const v of report.viewports) writeFileSync(join(root, v.screenshot.path), png);
  writeFileSync(join(root, prefix, 'mockups/browser.json'), JSON.stringify(report));
  const sha = gitCommitAll(root);
  const factory = createFactory({ stateDir: state });
  await switchExecution({ state, slug: 'p', mode: 'scrum', blockers: [], rotate: async () => {} });
  const paths = [...Object.keys(designFiles).map(p => prefix + p), ...report.viewports.map(v => v.screenshot.path)];
  const browserEvidence = [artifactAt(root, sha, prefix + 'mockups/browser.json')];
  const refs = paths.map(path => artifactAt(root, sha, path));
  let run = createScrumRun({ state, slug: 'p', runId: 'studio', initiativeId: 'studio', config: ensureScrumConfig(state), configRevision: 1, track: 'ui', rationale: 'checkout UI', requestId: 'create', ownedPaths: [...paths, browserEvidence[0].path] });
  run = commandRun(state, 'p', run.runId, { type: 'task_reserved', task: 'ux-studio', role: 'ux', required: true, requestId: 'reserve', expectedRevision: run.revision });
  const contract = factory.setContract({ task: 'ux-studio', workspace: root, gate: 'true', execution: { mode: 'scrum', role: 'ux', runId: run.runId, configRevision: run.configRevision, policyRevision: run.policyRevision, artifactRefs: [] } });
  run = commandRun(state, 'p', run.runId, { type: 'task_bound', task: contract.task, epoch: contract.seq, requestId: 'bind', expectedRevision: run.revision });
  const claim = await factory.claim({ task: contract.task, sha }); await factory.accept({ task: contract.task, attempt: claim.attempt });
  const ctx = { factory, root, slug: 'p', authority: 'owner' as const, actor: 'owner', activeAgents: [], pendingDirectives: false };
  const design = { revision: 1, digest: designDigest(refs), refs, browserEvidence };
  const submit = () => scrumOperation({ operation: 'run.command', runId: run.runId, requestId: 'submit', expectedRevision: run.revision, payload: { type: 'design_review_requested', design } }, ctx);
  return { root, state, run, report, design, ctx, submit };
}
