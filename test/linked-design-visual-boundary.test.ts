import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoleKickoffPrompt, renderRoleContract, renderRoleAppendSystem, renderSeatBootstrapPrompt } from '../src/roles-contract.ts';
import { buildSeatKickoffPacket } from '../src/preflight.ts';
import { linkedDesignSpecification } from '../src/linked-design.ts';

test('visual evidence boundary reaches only linked Lead surfaces', t => {
  const root = mkdtempSync(join(tmpdir(), 'visual-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { root, slug: 'visual' };
  const surfaces = (role: 'lead' | 'supervisor') => [
    renderRoleContract(role, { project }), buildRoleKickoffPrompt(role, { project }),
    renderRoleAppendSystem(role, { project }),
    renderSeatBootstrapPrompt({ seat: role, project, home: root, stateDir: root, nodePath: process.execPath, path: '/bin', lane: 'test' }),
    buildSeatKickoffPacket({ role, projectRoot: root, projectSlug: 'visual', ledgerEvents: [] }),
  ];
  const unlinked = surfaces('lead');
  assert.equal(linkedDesignSpecification(root), '');
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design/open-design-link.json'), JSON.stringify({ projectId: 'visual', projectName: 'Visual', sourceUpdatedAt: 1, syncedAt: '2026-11-14', digest: 'abc', screenCount: 2, files: [] }));
  for (const text of surfaces('lead')) {
    assert.match(text, /Visual-Evidence & Screenshot Boundary/);
    for (const fragment of ['report-<task>-<n>.md', '6-Field Handoff', 'git show --stat', 'git diff', 'Gate results', 'NEVER loads', '*.png', '*.jpg', '*.webp', 'evidence-*/', 'inline images persist', 'provider image caps', 'fresh read-only Peer', 'reviewer', 'scout', 'Task worktree', 'claim', 'file:line', 'blocking vs non-blocking']) assert.ok(text.includes(fragment), fragment);
    assert.match(text, /Design source \(a Lead NEVER reads/);
  }
  for (const text of [...unlinked, ...surfaces('supervisor'), buildRoleKickoffPrompt('agent', { project }), renderRoleContract('agent', { project }), linkedDesignSpecification(root)]) assert.doesNotMatch(text, /Visual-Evidence & Screenshot Boundary|NEVER loads/);
  rmSync(join(root, 'design'), { recursive: true });
  assert.deepEqual(surfaces('lead'), unlinked);
});
