/** Read-only Antigravity CLI history recovery, independent of a live daemon. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { resolveProject, projectStateDir, readProjectRegistration } from './project.ts';

interface TranscriptStep { idx: number; step_type: number; status: number; step_payload: Uint8Array | string }
interface TranscriptInput { home: string; target: string; project?: string; conversationsDir?: string; format?: 'md' | 'html' }
const safeName = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name);

function agentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? agentFiles(join(dir, entry.name)) : entry.isFile() && entry.name.endsWith('.json') ? [join(dir, entry.name)] : []);
}
function conversationFrom(record: Record<string, any>): string | undefined {
  const persistence = record.persistence;
  const metadataId = persistence?.metadata?.pluginProviderPersistence?.data?.conversationId;
  if (typeof metadataId === 'string' && safeName(metadataId)) return metadataId;
  for (const session of [persistence?.sessionId, record.runtimeInfo?.sessionId]) {
    if (typeof session !== 'string' || !session.startsWith('plugin:')) continue;
    try {
      const id = JSON.parse(session.slice(7)).data?.conversationId;
      if (typeof id === 'string' && safeName(id)) return id;
    } catch { /* Try the other persisted session id. */ }
  }
  return undefined;
}
function jsonlPath(conversations: string, id: string): string | undefined {
  for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const candidate = join(dirname(conversations), 'brain', id, '.system_generated/logs', file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
function resolveConversation(input: TranscriptInput, conversations: string): string {
  let target = input.target;
  if (target === 'supervisor' || target === 'lead') {
    const project = resolveProject(input.project ?? process.cwd());
    if (!project.ok) throw new Error(`Cannot resolve Project: ${project.reason}`);
    const registration = readProjectRegistration(join(input.home, 'plugin-state/paseo-factory'), project.slug);
    const agentId = registration?.[target];
    if (!agentId) throw new Error(`No ${target} seat recorded in ${projectStateDir(join(input.home, 'plugin-state/paseo-factory'), project.slug)}/project.json`);
    target = agentId;
  }
  if (!safeName(target)) throw new Error('Invalid agent or conversation id');
  const files = agentFiles(join(input.home, 'agents'));
  const exact = files.filter(file => basename(file, '.json') === target);
  const matches = exact.length ? exact : files.filter(file => basename(file, '.json').startsWith(target));
  if (matches.length > 1) throw new Error(`Ambiguous agent prefix: ${target}`);
  if (matches.length === 1) {
    const id = conversationFrom(JSON.parse(readFileSync(matches[0], 'utf8')));
    if (!id) throw new Error(`Agent ${target} has no Antigravity conversation id`);
    return id;
  }
  if (jsonlPath(conversations, target) || existsSync(join(conversations, target + '.db'))) return target;
  throw new Error(`No agent or conversation found for ${target}`);
}

function readSteps(path: string): TranscriptStep[] {
  if (!existsSync(path)) throw new Error(`Antigravity conversation database is missing: ${path}`);
  let sqlite: typeof import('node:sqlite') | undefined;
  try { sqlite = createRequire(join(process.cwd(), 'factory-sqlite.cjs'))('node:sqlite'); } catch { /* Older Node / Electron: use sqlite3. */ }
  if (sqlite) {
    const db: DatabaseSync = new sqlite.DatabaseSync(path, { readOnly: true });
    // TEXT columns can hold wire bytes too. Prevent SQLite's JS adapter from
    // replacing non-UTF-8 varint bytes before the protobuf decoder sees them.
    try { return db.prepare('SELECT idx, step_type, status, CAST(step_payload AS BLOB) AS step_payload FROM steps ORDER BY idx ASC').all() as unknown as TranscriptStep[]; }
    finally { db.close(); }
  }
  // hex() transports both BLOB and TEXT protobuf bytes losslessly through JSON.
  const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', path, 'SELECT idx, step_type, status, hex(step_payload) AS payload_hex FROM steps ORDER BY idx ASC'], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '[]');
  return rows.map((row: any) => ({ ...row, step_payload: Buffer.from(row.payload_hex, 'hex') }));
}

/** Walk protobuf messages without assuming the provider's undocumented field numbers. */
function wireStrings(bytes: Uint8Array, depth = 0): string[] | undefined {
  if (depth > 20) return undefined;
  let offset = 0; const strings: string[] = [];
  const varint = (): number => {
    let value = 0, shift = 0;
    for (let count = 0; count < 10; count++) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf varint');
      const b = bytes[offset++]; value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
    throw new Error('Invalid protobuf varint');
  };
  try {
    while (offset < bytes.length) {
      const tag = varint(); if (!Number.isSafeInteger(tag) || tag < 8) return undefined;
      switch (tag % 8) {
        case 0: varint(); break;
        case 1: offset += 8; break;
        case 5: offset += 4; break;
        case 2: {
          const length = varint(); if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) return undefined;
          const field = bytes.subarray(offset, offset + length); offset += length;
          const nested = wireStrings(field, depth + 1);
          if (nested?.length) { strings.push(...nested); break; }
          let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(field); } catch { break; }
          if (text.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) && !/^(?:[a-f\d]{8}-[a-f\d-]{27,}|[a-f\d]{32,})$/i.test(text.trim())) strings.push(text);
          break;
        }
        default: return undefined;
      }
      if (offset > bytes.length) return undefined;
    }
    return strings;
  } catch { return undefined; }
}
export function decodeAntigravityPayload(payload: Uint8Array | string): string {
  // TEXT payloads contain the protobuf wire string itself, not base64 or JSON.
  return (wireStrings(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload) ?? []).join('\n\n');
}
function readJsonlTurns(path: string): Array<{ role: string; text: string; idx: number; status: string | number }> {
  const roles: Record<string, string> = { USER_INPUT: 'User', PLANNER_RESPONSE: 'Assistant', GENERIC: 'Tool', ERROR_MESSAGE: 'Error' };
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const step = JSON.parse(line);
      const role = roles[step.type]; if (!role) return [];
      const parts = [
        typeof step.thinking === 'string' && step.thinking.trim() ? `Thinking:\n${step.thinking.trim()}` : '',
        Array.isArray(step.tool_calls) ? step.tool_calls.map((c: any) => `Tool call: ${c.name}(${JSON.stringify(c.args ?? {})})`).join('\n') : '',
        typeof step.content === 'string' ? step.content.trim() : '',
        typeof step.error === 'string' ? step.error.trim() : '',
      ].filter(Boolean);
      return parts.length ? [{ role, text: parts.join('\n\n'), idx: step.step_index ?? 0, status: step.status ?? 'DONE' }] : [];
    } catch { return []; }
  });
}
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function antigravityTranscript(input: TranscriptInput): string {
  const conversations = input.conversationsDir ?? join(homedir(), '.gemini/antigravity-cli/conversations');
  const id = resolveConversation(input, conversations);
  const jsonl = jsonlPath(conversations, id);
  const roles: Record<number, string> = { 14: 'User', 15: 'Assistant', 101: 'Tool', 132: 'Tool' };
  const turns = jsonl ? readJsonlTurns(jsonl) : readSteps(join(conversations, id + '.db')).flatMap(step => {
    const role = roles[step.step_type]; if (!role) return [];
    const text = decodeAntigravityPayload(step.step_payload);
    return text ? [{ role, text, idx: step.idx, status: step.status }] : [];
  });
  if (input.format === 'html') return `<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Antigravity transcript</title><style>body{max-width:900px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #ccc}</style><body><h1>Antigravity transcript</h1><p>${escapeHtml(id)}</p>${turns.map(turn => `<section><h2>${turn.role} · step ${turn.idx} · status ${turn.status}</h2><pre>${escapeHtml(turn.text)}</pre></section>`).join('\n')}</body></html>\n`;
  return `# Antigravity transcript\n\nConversation: ${id}\n\n${turns.map(turn => `## ${turn.role} · step ${turn.idx} · status ${turn.status}\n\n${turn.text}\n`).join('\n')}`;
}
