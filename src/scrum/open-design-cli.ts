import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectOpenDesignHost, openDesignWorkspace, stageOpenDesignFrames } from './open-design.ts';
import { runOpenDesignLint } from './open-design-lint.ts';

/** Read all local assets so HTML, CSS URLs and frame references share one integrity boundary. */
export function readMockupFiles(mockupsDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) walk(path, name + '/');
      else if (entry.isFile()) files[name] = /\.(?:html|css|js|json|md|svg)$/i.test(name) ? readFileSync(path, 'utf8') : '[binary asset]';
    }
  };
  readdirSync(mockupsDir);
  walk(mockupsDir, 'mockups/');
  for (const name of ['DESIGN.md', 'EXPERIENCE.md']) if (existsSync(join(dirname(mockupsDir), name))) files[name] = readFileSync(join(dirname(mockupsDir), name), 'utf8');
  return files;
}

export async function openDesignCommand(action: string, dir: string, args: string[] = []): Promise<{ code: number; data: unknown }> {
  if (action === 'inspect') return { code: 0, data: inspectOpenDesignHost() };
  if (action === 'od') {
    const host = inspectOpenDesignHost();
    if (!host.cli) return { code: 2, data: { error: 'Native Open Design CLI unavailable; embedded stage/lint remain usable' } };
    const result = spawnSync(process.execPath, [host.cli, ...args], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(host.daemonUrl ? { OD_DAEMON_URL: host.daemonUrl } : {}) } });
    return { code: result.status ?? 2, data: null };
  }
  if (!dir) return { code: 2, data: { error: '--dir <mockupsDir> required' } };
  if (action === 'stage') return { code: 0, data: { staged: stageOpenDesignFrames(dir) } };
  if (action === 'lint') {
    const findings = runOpenDesignLint(readMockupFiles(dir));
    return { code: findings.length ? 1 : 0, data: { tool: 'open-design', passed: !findings.length, nonAdvisoryCount: findings.length, findings: findings.map(f => ({ ruleId: f.category, severity: 'error', message: `${f.path}:${f.line}: ${f.message}` })) } };
  }
  if (action === 'sync') {
    const host = inspectOpenDesignHost();
    const daemon = host.daemonUrl ?? (host.available ? 'http://127.0.0.1:7456' : null);
    if (!daemon) return { code: 2, data: { error: 'Native Open Design host unavailable; embedded engine remains usable' } };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const sidecar = host.resourceRoot && join(dirname(host.resourceRoot), 'app/node_modules/@open-design/sidecar/dist/index.mjs');
    if (sidecar && existsSync(sidecar)) {
      const { SidecarFactory } = await import(pathToFileURL(sidecar).href);
      const client = SidecarFactory.connectInherited();
      if (client) {
        const result = await client.invoke('daemon', 'mint-import-token', { baseDir: openDesignWorkspace(dir, dir).baseDir }, { timeoutMs: 800 });
        if (result?.ok && result.token) headers['x-od-desktop-import-token'] = result.token;
      }
    }
    const response = await fetch(new URL('/api/import/folder', daemon), { method: 'POST', headers, body: JSON.stringify(openDesignWorkspace(dir, dir)), signal: AbortSignal.timeout(10_000) });
    const data = await response.json();
    return { code: response.ok ? 0 : 1, data };
  }
  return { code: 2, data: { error: 'Expected open-design stage|lint|inspect|sync|od' } };
}
