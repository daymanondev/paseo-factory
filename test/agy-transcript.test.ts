import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveProject } from '../src/project.ts';

function field(text: string | Buffer): Buffer {
  const bytes = Buffer.from(text); const size: number[] = []; let n = bytes.length;
  while (n > 127) { size.push((n & 127) | 128); n >>>= 7; } size.push(n);
  return Buffer.concat([Buffer.from([10, ...size]), bytes]);
}

test('transcript CLI exports SQLite steps by agent prefix, direct conversation, and standing seat without changing the database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-transcript-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), project = join(dir, 'project'), conversations = join(dir, 'conversations');
  for (const path of [join(home, 'agents/nested'), project, conversations]) mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const resolution = resolveProject(project); assert.ok(resolution.ok);
  const state = join(home, 'plugin-state/paseo-factory/projects', resolution.slug); mkdirSync(state, { recursive: true });
  const agentId = 'f1234567-0000-4000-8000-123456789abc', conversationId = 'c1234567-0000-4000-8000-123456789abc';
  writeFileSync(join(state, 'project.json'), JSON.stringify({ root: project, supervisor: agentId, lead: agentId }));
  const agentPath = join(home, 'agents/nested', agentId + '.json');
  writeFileSync(agentPath, JSON.stringify({ id: agentId, persistence: { metadata: { pluginProviderPersistence: { data: { conversationId } } } } }));
  const dbPath = join(conversations, conversationId + '.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB)');
  const put = db.prepare('INSERT INTO steps VALUES (?, ?, 1, ?)');
  put.run(2, 132, field('Tool output: <script>alert("x")</script>'));
  put.run(0, 14, Buffer.concat([field(agentId), field('Please build Goal Partner')]));
  put.run(1, 15, field(field('I will build the dashboard — tiếng Việt')));
  put.run(3, 101, field('hi'));
  put.run(4, 15, Buffer.from([10, 255])); // Truncated messages must not crash recovery.
  const longResponse = 'Long text-backed protobuf response with Unicode tiếng Việt. '.repeat(6);
  db.prepare('INSERT INTO steps VALUES (?, ?, 1, CAST(? AS TEXT))').run(5, 15, field(longResponse));
  db.close(); const before = readFileSync(dbPath);
  const cli = (...args: string[]) => execFileSync(process.execPath, [resolve('plugin/bin/factory.mjs'), '--home', home, 'transcript', ...args, '--conversations-dir', conversations], { encoding: 'utf8' });
  const md = cli('f1234567');
  assert.match(md, /User[\s\S]*Please build Goal Partner[\s\S]*Assistant[\s\S]*I will build the dashboard[\s\S]*Tool/);
  assert.ok(!md.includes(agentId));
  assert.ok(md.includes(longResponse), 'SQLite TEXT must preserve protobuf varint bytes');
  assert.match(md, /tiếng Việt/); assert.match(md, /\nhi\n/);
  const fallback = execFileSync(process.execPath, ['--no-experimental-sqlite', resolve('plugin/bin/factory.mjs'), '--home', home, 'transcript', 'f1234567', '--conversations-dir', conversations], { encoding: 'utf8' });
  assert.equal(fallback, md);
  const out = join(dir, 'transcript.html');
  assert.equal(cli('supervisor', '--project', project, '--format', 'html', '--out', out), '');
  const html = readFileSync(out, 'utf8'); assert.match(html, /<!doctype html>/i); assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<script>'));
  for (const location of ['persistence', 'runtimeInfo']) {
    writeFileSync(agentPath, JSON.stringify({ [location]: { sessionId: 'plugin:' + JSON.stringify({ version: 1, data: { conversationId } }) } }));
    assert.match(cli('lead', '--project', project), /Please build Goal Partner/);
  }
  assert.match(cli(conversationId), /Please build Goal Partner/);
  writeFileSync(join(home, 'agents/nested/f1234567-other.json'), '{}');
  const ambiguous = spawnSync(process.execPath, [resolve('plugin/bin/factory.mjs'), '--home', home, 'transcript', 'f1234567', '--conversations-dir', conversations], { encoding: 'utf8' });
  assert.equal(ambiguous.status, 2); assert.match(ambiguous.stderr, /ambiguous/i);
  assert.deepEqual(readFileSync(dbPath), before);
  rmSync(join(home, 'agents/nested/f1234567-other.json'));
  const logsDir = join(dir, 'brain', conversationId, '.system_generated/logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'Build Goal Partner from JSONL' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'Checking Open Design link', tool_calls: [{ name: 'run_command', args: { cmd: 'npm test' } }], content: 'Dispatched GP-T01a' }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'PASS test/design-provenance.test.ts' }),
  ].join('\n'));
  const fromJsonl = cli('supervisor', '--project', project);
  assert.match(fromJsonl, /Build Goal Partner from JSONL/);
  assert.match(fromJsonl, /Thinking:\nChecking Open Design link/);
  assert.match(fromJsonl, /Tool call: run_command\(\{"cmd":"npm test"\}\)/);
  assert.match(fromJsonl, /PASS test\/design-provenance\.test\.ts/);
});
