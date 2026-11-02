import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readOpenDesignLink, exportOpenDesignProject, syncOpenDesignLink, prepareOpenDesignDispatch } from '../src/scrum/open-design-link.ts';
import { linkedDesignSpecification } from '../src/linked-design.ts';
import { resolveProject } from '../src/project.ts';
import { createFactory } from '../plugin/server/core/factory.ts';
import { createSurfaceHandlers, type SurfaceDaemonApi } from '../plugin/server/surface-rpc.ts';
import { OpenDesignProjectLinkSchema } from '../plugin/shared/view.ts';

const recorded = { projectId: 'goal-partner', projectName: 'Goal Partner', sourceUpdatedAt: 1, syncedAt: '2026-11-02', digest: 'abc', screenCount: 3, files: ['index.html'] };
const provenance = { tool: 'open-design', namespace: 'release-stable', projectId: 'goal-partner', sourcePath: '/source', app: 'index.html', screenboard: 'screens.html', importedAt: '2026-11-02', note: 'Imported by Peer' };

test('link reader rejects foreign provenance and malformed schemas; prompts fall back to the recorded link', t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-link-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'design'));
  assert.equal(readOpenDesignLink(root), undefined);
  for (const value of [provenance, null, [], { ...recorded, projectId: '../escape' }, { ...recorded, files: [1] }, { ...recorded, directionId: 3 }, { ...recorded, digest: '' }, { ...recorded, screenCount: null }]) {
    writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify(value));
    assert.equal(readOpenDesignLink(root), undefined);
    assert.match(linkedDesignSpecification(root, recorded), /Goal Partner · 3 screens/);
    assert.ok(OpenDesignProjectLinkSchema.safeParse(readOpenDesignLink(root) ?? recorded).success);
  }
  writeFileSync(join(root, 'design/open-design-link.json'), '{bad json');
  assert.equal(readOpenDesignLink(root), undefined);
  writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify(recorded));
  assert.deepEqual(readOpenDesignLink(root), recorded);
});

test('dispatch preserves a populated provenance bundle and restores the recorded link after Project reset', async t => {
  const base = mkdtempSync(join(tmpdir(), 'factory-link-reset-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), state = join(base, 'state'), catalog = join(base, 'catalog');
  const old = process.env.OPEN_DESIGN_DATA_DIR; process.env.OPEN_DESIGN_DATA_DIR = catalog;
  t.after(() => { if (old === undefined) delete process.env.OPEN_DESIGN_DATA_DIR; else process.env.OPEN_DESIGN_DATA_DIR = old; });
  mkdirSync(root); mkdirSync(join(catalog, 'projects/goal-partner'), { recursive: true });
  writeFileSync(join(catalog, 'projects/goal-partner/index.html'), '<html><section data-screen="home">Goal Partner</section></html>');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('commit', '--allow-empty', '-qm', 'initial');
  const project = resolveProject(root); assert.ok(project.ok); const slug = project.slug;
  const bundle = exportOpenDesignProject('goal-partner');
  syncOpenDesignLink({ root, state, slug, bundle });
  // Host source for subsequent dispatches; client sources require an RPC acknowledgement.
  const execution = join(state, 'projects', slug, 'execution.json');
  const selection = JSON.parse(readFileSync(execution, 'utf8'));
  writeFileSync(execution, JSON.stringify({ ...selection, openDesignSource: { kind: 'host' } }));
  const note = JSON.stringify(provenance), manifest = '{"provenance":"Peer-authored"}';
  writeFileSync(join(root, 'design/open-design-link.json'), note);
  writeFileSync(join(root, 'design/design-manifest.json'), manifest);
  const head = git('rev-parse', 'HEAD');
  const factory = createFactory({ stateDir: state });
  const surface = createSurfaceHandlers({ factory, stateDir: state, home: base, daemon: {} as SurfaceDaemonApi });
  const status = await surface.openDesignStatus({ projectRoot: root });
  assert.ok(status.ok);
  assert.ok(OpenDesignProjectLinkSchema.safeParse(status.link).success);
  assert.equal(status.link?.projectId, 'goal-partner');
  await prepareOpenDesignDispatch({ root, state, slug });
  assert.equal(readFileSync(join(root, 'design/open-design-link.json'), 'utf8'), note);
  assert.equal(readFileSync(join(root, 'design/design-manifest.json'), 'utf8'), manifest);
  assert.equal(git('rev-parse', 'HEAD'), head);
  rmSync(join(root, 'design'), { recursive: true });
  await prepareOpenDesignDispatch({ root, state, slug });
  assert.match(readFileSync(join(root, 'design/index.html'), 'utf8'), /Goal Partner/);
  assert.equal(readOpenDesignLink(root)?.projectId, 'goal-partner');
  assert.equal(git('status', '--porcelain'), '');
});
