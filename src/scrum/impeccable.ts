import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FactoryError } from '../errors.ts';

export const IMPECCABLE_MIN_VERSION = '4.8.0';

export const CORE_FACTORY_SKILLS = [
  'tdd',
  'diagnosing-bugs',
  'codebase-design',
  'frontend-design',
  'web-design-guidelines',
  'code-review',
  'grilling',
  'domain-modeling',
  'grill-with-docs',
  'factory',
] as const;

export type CompanionToolRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => { status: number; stdout: string; stderr: string };

/** Compares two `major.minor.patch` semantic version strings (`-1`, `0`, `1`). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const clean = v.trim().replace(/^v/i, '').split('-')[0] ?? '';
    const parts = clean.split('.').map((p) => Number.parseInt(p, 10));
    return [
      Number.isFinite(parts[0]) ? parts[0]! : 0,
      Number.isFinite(parts[1]) ? parts[1]! : 0,
      Number.isFinite(parts[2]) ? parts[2]! : 0,
    ];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPat !== bPat) return aPat > bPat ? 1 : -1;
  return 0;
}

export interface ImpeccableInspection {
  status: 'installed' | 'outdated' | 'not_installed';
  version: string | null;
  engineVersion?: string | null;
  minVersion: string;
  path: string | null;
  binaryPath: string | null;
  skillCount: number;
}

/**
 * Inspects whether upstream `pbakaus/impeccable` (`>= 4.8.0`) is installed under
 * `<userHome>/.agents/skills/impeccable` (or fallback provider skill directories),
 * verifying `SKILL.md` frontmatter `version:` (package version, e.g. `4.8.0`),
 * executable `scripts/impeccable`, and `scripts/VERSION` (native engine version, e.g. `0.1.18`).
 */
export function inspectImpeccableTool(userHome = homedir()): ImpeccableInspection {
  const providers = ['.agents', '.claude', '.gemini', '.pi', '.codex', '.opencode'];
  let mainDir: string | null = null;
  const skillNames = new Set<string>();
  for (const provider of providers) {
    const dir = join(userHome, provider, 'skills');
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (/^impeccable(?:$|[-_])/.test(name) && existsSync(join(dir, name, 'SKILL.md'))) {
          skillNames.add(name);
          if (name === 'impeccable' && mainDir === null) {
            mainDir = join(dir, name);
          }
        }
      }
    } catch {
      // ignore unreadable provider dir
    }
  }
  if (mainDir === null) {
    return {
      status: 'not_installed',
      version: null,
      engineVersion: null,
      minVersion: IMPECCABLE_MIN_VERSION,
      path: null,
      binaryPath: null,
      skillCount: skillNames.size,
    };
  }
  const binaryCandidate = join(mainDir, 'scripts', 'impeccable');
  const hasBinary = existsSync(binaryCandidate);
  let skillVersion: string | null = null;
  const skillMdPath = join(mainDir, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    try {
      const md = readFileSync(skillMdPath, 'utf8');
      const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const verMatch = fm?.[1]?.match(/^\s*version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+[^\s"']*)["']?\s*$/m);
      if (verMatch?.[1]) {
        skillVersion = verMatch[1].trim();
      }
    } catch {
      skillVersion = null;
    }
  }
  const versionPath = join(mainDir, 'scripts', 'VERSION');
  let engineVersion: string | null = null;
  if (existsSync(versionPath)) {
    try {
      const raw = readFileSync(versionPath, 'utf8').trim();
      if (raw !== '') engineVersion = raw;
    } catch {
      engineVersion = null;
    }
  }
  let version = skillVersion ?? engineVersion;
  if (version === null && hasBinary) {
    version = IMPECCABLE_MIN_VERSION;
  }
  if (!hasBinary || version === null) {
    return {
      status: 'not_installed',
      version,
      engineVersion,
      minVersion: IMPECCABLE_MIN_VERSION,
      path: mainDir,
      binaryPath: hasBinary ? binaryCandidate : null,
      skillCount: skillNames.size,
    };
  }
  const upToDate = compareSemver(version, IMPECCABLE_MIN_VERSION) >= 0;
  return {
    status: upToDate ? 'installed' : 'outdated',
    version,
    engineVersion,
    minVersion: IMPECCABLE_MIN_VERSION,
    path: mainDir,
    binaryPath: binaryCandidate,
    skillCount: skillNames.size,
  };
}

export interface FactorySkillPackInspection {
  status: 'installed' | 'partial' | 'not_installed';
  installedSkills: string[];
  missingCoreSkills: string[];
  totalSkills: number;
  path: string;
}

/**
 * Inspects `<userHome>/.agents/skills` for the core Factory skill pack
 * (`tdd`, `diagnosing-bugs`, `codebase-design`, `frontend-design`, etc.).
 */
export function inspectFactorySkillPack(userHome = homedir()): FactorySkillPackInspection {
  const skillsDir = join(userHome, '.agents', 'skills');
  if (!existsSync(skillsDir)) {
    return {
      status: 'not_installed',
      installedSkills: [],
      missingCoreSkills: [...CORE_FACTORY_SKILLS],
      totalSkills: 0,
      path: skillsDir,
    };
  }
  const installedSkills: string[] = [];
  try {
    for (const name of readdirSync(skillsDir)) {
      if (name.startsWith('.') || /^impeccable(?:$|[-_])/.test(name)) continue;
      if (existsSync(join(skillsDir, name, 'SKILL.md'))) {
        installedSkills.push(name);
      }
    }
  } catch {
    // ignore unreadable directory
  }
  installedSkills.sort();
  const presentSet = new Set(installedSkills);
  const missingCoreSkills = CORE_FACTORY_SKILLS.filter((s) => !presentSet.has(s));
  const status =
    installedSkills.length === 0
      ? 'not_installed'
      : missingCoreSkills.length === 0
        ? 'installed'
        : 'partial';
  return {
    status,
    installedSkills,
    missingCoreSkills,
    totalSkills: installedSkills.length,
    path: skillsDir,
  };
}

/**
 * Ensures every skill directory in `<userHome>/.agents/skills/*` is symlinked
 * into `<userHome>/.pi/agent/skills/<name>`, `<userHome>/.claude/skills/<name>`,
 * and `<userHome>/.gemini/config/skills/<name>` (unless `~/.gemini/config/skills`
 * is already a directory symlink to `~/.agents/skills`).
 */
export function ensureProviderSkillSymlinks(userHome = homedir()): { linked: string[] } {
  const agentsSkillsDir = join(userHome, '.agents', 'skills');
  if (!existsSync(agentsSkillsDir)) return { linked: [] };
  let skillNames: string[] = [];
  try {
    skillNames = readdirSync(agentsSkillsDir).filter((name) => {
      if (name.startsWith('.')) return false;
      const skillPath = join(agentsSkillsDir, name);
      try {
        return statSync(skillPath).isDirectory() && existsSync(join(skillPath, 'SKILL.md'));
      } catch {
        return false;
      }
    });
  } catch {
    return { linked: [] };
  }
  if (skillNames.length === 0) return { linked: [] };

  const providerTargets = [
    join(userHome, '.pi', 'agent', 'skills'),
    join(userHome, '.claude', 'skills'),
    join(userHome, '.gemini', 'config', 'skills'),
  ];
  const resolvedAgentsSkills = (() => {
    try {
      return resolve(agentsSkillsDir);
    } catch {
      return agentsSkillsDir;
    }
  })();

  const linked: string[] = [];
  for (const targetDir of providerTargets) {
    try {
      if (existsSync(targetDir)) {
        const st = lstatSync(targetDir);
        if (st.isSymbolicLink()) {
          // If the whole provider skills dir already points to ~/.agents/skills, skip per-skill links.
          try {
            if (resolve(targetDir) === resolvedAgentsSkills) continue;
          } catch {
            // broken symlink — replace below
          }
        }
      }
      mkdirSync(targetDir, { recursive: true });
      for (const name of skillNames) {
        const dest = join(targetDir, name);
        const src = join(agentsSkillsDir, name);
        let existsValid = false;
        try {
          const lst = lstatSync(dest);
          if (lst.isSymbolicLink()) {
            existsValid = existsSync(dest);
            if (!existsValid) rmSync(dest, { force: true });
          } else {
            existsValid = true;
          }
        } catch {
          existsValid = false;
        }
        if (!existsValid) {
          mkdirSync(dirname(dest), { recursive: true });
          symlinkSync(src, dest, 'dir');
          linked.push(dest);
        }
      }
    } catch {
      // best-effort per provider dir
    }
  }
  return { linked };
}

function buildToolInstallEnv(userHome: string): NodeJS.ProcessEnv {
  const pathParts = [
    process.env.PATH ?? '',
    join(userHome, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean);
  return {
    ...process.env,
    HOME: userHome,
    PATH: [...new Set(pathParts.join(':').split(':').filter(Boolean))].join(':'),
  };
}

function defaultCompanionToolRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: [res.stderr ?? '', res.error?.message ?? ''].filter(Boolean).join('\n'),
  };
}

/**
 * Installs or updates upstream `pbakaus/impeccable` (`>= 4.8.0`) into `<userHome>/.agents/skills/impeccable`
 * via `npx --yes impeccable@latest install --scope=global` and reconciles provider skill symlinks.
 */
export function installOrUpdateImpeccableTool(options?: {
  userHome?: string;
  action?: 'install' | 'update';
  runner?: CompanionToolRunner;
}): { ok: true; version: string; path: string; summary: string } | { ok: false; reason: string } {
  const userHome = options?.userHome ?? homedir();
  const action = options?.action ?? 'install';
  const runner = options?.runner ?? defaultCompanionToolRunner;
  mkdirSync(userHome, { recursive: true });
  const env = buildToolInstallEnv(userHome);
  const args = [
    '--yes',
    'impeccable@latest',
    'install',
    '--yes',
    '--global',
    '--no-hooks',
    '--force',
    '--providers=codex,claude,gemini,opencode,pi',
  ];
  const result = runner('npx', args, { cwd: userHome, env });
  ensureProviderSkillSymlinks(userHome);
  const after = inspectImpeccableTool(userHome);
  if (result.status !== 0 || after.status !== 'installed' || after.path === null) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' — ') || `exit ${result.status}`;
    return {
      ok: false,
      reason: `impeccable ${action} failed (${detail})`,
    };
  }
  const verb = action === 'update' ? 'Updated' : 'Installed';
  return {
    ok: true,
    version: after.version ?? IMPECCABLE_MIN_VERSION,
    path: after.path,
    summary: `${verb} Impeccable v${after.version ?? IMPECCABLE_MIN_VERSION} (${after.skillCount} skill${after.skillCount === 1 ? '' : 's'}) and linked provider skills.`,
  };
}

/** Discover whole upstream directories; keep references, scripts and engine together. */
export function provisionImpeccable(
  roleHome: string,
  userHome: string,
  sourceCodexHome = join(userHome, '.codex'),
  options?: { autoInstall?: boolean; requireInstalled?: boolean; runner?: CompanionToolRunner },
): string[] {
  const shouldAutoInstall =
    options?.autoInstall === true ||
    (options?.autoInstall !== false && userHome === homedir() && !process.env.NODE_TEST_CONTEXT);
  if (shouldAutoInstall) {
    ensureProviderSkillSymlinks(userHome);
    const inspected = inspectImpeccableTool(userHome);
    if (inspected.status !== 'installed') {
      const installed = installOrUpdateImpeccableTool({
        userHome,
        action: inspected.status === 'outdated' ? 'update' : 'install',
        runner: options?.runner,
      });
      if (!installed.ok && options?.requireInstalled !== false) {
        throw new FactoryError(
          'tool-missing',
          `Impeccable UI detector (>= ${IMPECCABLE_MIN_VERSION}) is required for Scrum UI roles and automatic provisioning failed: ${installed.reason}`,
        );
      }
    }
  } else if (options?.requireInstalled === true) {
    const inspected = inspectImpeccableTool(userHome);
    if (inspected.status !== 'installed') {
      throw new FactoryError(
        'tool-missing',
        `Impeccable UI detector (>= ${IMPECCABLE_MIN_VERSION}) is missing under ${userHome}/.agents/skills/impeccable`,
      );
    }
  }

  const skills = new Map<string, string>();
  for (const provider of ['.agents', '.claude', '.gemini', '.pi', '.codex', '.opencode']) {
    const dir = join(userHome, provider, 'skills');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^impeccable(?:$|[-_])/.test(name) && existsSync(join(dir, name, 'SKILL.md')) && !skills.has(name)) skills.set(name, join(dir, name));
    }
  }
  const target = join(roleHome, 'skills');
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) rmSync(target);
  mkdirSync(target, { recursive: true });
  for (const [name, path] of skills) {
    rmSync(join(target, name), { recursive: true, force: true });
    symlinkSync(path, join(target, name), 'dir');
  }
  const launcher = skills.has('impeccable') && existsSync(join(skills.get('impeccable')!, 'scripts/impeccable')) ? join(skills.get('impeccable')!, 'scripts/impeccable') : 'impeccable';
  const extension = join(roleHome, 'impeccable-hook.mjs');
  // Pi's tool_result is its postToolUse seam. Non-UI edits never start a process.
  writeFileSync(extension, `import { spawnSync } from 'node:child_process';
export default function(pi) {
  pi.on('tool_result', async (event, ctx) => {
    if (!['write','edit','Write','Edit','apply_patch'].includes(event.toolName)) return;
    const input = event.input || {}, path = input.path || input.file_path || '';
    const patch = input.patch || input.input || '';
    if (!/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/i.test(path) && !/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)(?:\\s|$)/im.test(patch)) return;
    const result = spawnSync(${JSON.stringify(launcher)}, ['hook'], { cwd: ctx.cwd, input: JSON.stringify({ tool_name: event.toolName, tool_input: input, tool_response: event }), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = [result.stdout,result.stderr].filter(Boolean).join('\\n');
    if (output || result.error) return { content: [...(event.content || []), { type:'text', text:'Impeccable postToolUse: '+(output || result.error.message) }] };
  });
}\n`);
  const command = "'" + launcher.replace(/'/g, "'\\''") + "' hook";
  // Emit the native hook manifest too; never write the user's global settings.
  writeFileSync(join(roleHome, 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command, timeout: 5 }] }] } }, null, 2) + '\n');
  mkdirSync(join(roleHome, '.claude-plugin'), { recursive: true });
  mkdirSync(join(roleHome, 'hooks'), { recursive: true });
  writeFileSync(join(roleHome, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'factory-scrum-ui', version: '1.0.0', description: 'Role-scoped upstream Impeccable skills and scanner' }));
  const nativeHooks = JSON.parse(readFileSync(join(roleHome, 'hooks.json'), 'utf8'));
  writeFileSync(join(roleHome, 'hooks/hooks.json'), JSON.stringify(nativeHooks));
  writeFileSync(join(roleHome, 'agy-settings.json'), JSON.stringify(nativeHooks));
  // OpenCode uses a native plugin, scoped to the dedicated server's environment.
  writeFileSync(join(roleHome, 'impeccable-opencode.mjs'), `import { spawnSync } from 'node:child_process';
export default async function({directory}) { return { 'tool.execute.after': async (event, output) => {
  const args=event.args||{}, file=args.filePath||args.file_path||args.path||'', patch=args.patchText||args.patch||'';
  if (!['write','edit','apply_patch'].includes(event.tool) || (!/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)$/i.test(file) && !/\\.(html|css|scss|jsx|tsx|vue|svelte|astro)(?:\\s|$)/im.test(patch))) return;
  const result=spawnSync(${JSON.stringify(launcher)},['hook'],{cwd:directory,input:JSON.stringify({tool_name:event.tool,tool_input:args,tool_response:output}),encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  const text=[result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\\n');
  if(text)output.output=(output.output||'')+'\\nImpeccable postToolUse: '+text;
} } }`);
  // Copilot has a distinct hook schema; its plugin root is separate from Claude's.
  const copilot = join(roleHome, 'copilot');
  mkdirSync(join(copilot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(copilot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'factory-scrum-ui', version: '1.0.0' }));
  rmSync(join(copilot, 'skills'), { recursive: true, force: true });
  symlinkSync(target, join(copilot, 'skills'), 'dir');
  writeFileSync(join(copilot, 'hooks.json'), JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: 'command', bash: command, timeoutSec: 5 }] } }));
  // Codex reads its native hooks from CODEX_HOME. Preserve auth/provider config.
  for (const name of ['auth.json', 'config.toml']) {
    const source = join(sourceCodexHome, name), dest = join(roleHome, name);
    if (existsSync(source) && !existsSync(dest)) { if (name === 'config.toml') copyFileSync(source, dest); else symlinkSync(source, dest); }
  }
  return [...skills.keys()];
}

/** Launch overlays are confined to the specialist process; preserve operator config. */
export function impeccableEnvironment(roleHome: string, environment: Record<string, string | undefined>): Record<string, string> {
  environment = restoreImpeccableEnvironment(environment);
  let openCode: Record<string, unknown> = {};
  try { const parsed = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) openCode = parsed; } catch { throw new Error('Invalid OPENCODE_CONFIG_CONTENT; cannot safely add the UI scanner'); }
  const existingSkills = typeof openCode.skills === 'object' && openCode.skills ? openCode.skills as Record<string, unknown> : {};
  return {
    PASEO_FACTORY_UI_BASE_ENV: JSON.stringify(Object.fromEntries(['CODEX_HOME','OPENCODE_CONFIG_CONTENT','OMP_PROFILE','PI_PROFILE'].map(key => [key, environment[key] ?? null]))),
    PASEO_FACTORY_IMPECCABLE: join(roleHome, 'skills/impeccable/scripts/impeccable'),
    PASEO_FACTORY_UI_HOME: roleHome,
    CODEX_HOME: roleHome,
    OMP_PROFILE: '', PI_PROFILE: '',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...openCode, plugin: [...new Set([...(Array.isArray(openCode.plugin) ? openCode.plugin : []), pathToFileURL(join(roleHome, 'impeccable-opencode.mjs')).href])], skills: { ...existingSkills, paths: [...new Set([...(Array.isArray(existingSkills.paths) ? existingSkills.paths : []), join(roleHome, 'skills')])] } }),
  };
}

/** Remove Factory-owned overlays before changing identity or rebuilding a session. */
export function restoreImpeccableEnvironment<T extends Record<string, string | undefined>>(environment: T): Record<string, string> {
  const restored = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  const base = environment.PASEO_FACTORY_UI_BASE_ENV;
  if (base) {
    try {
      const original = JSON.parse(base);
      for (const key of ['CODEX_HOME','OPENCODE_CONFIG_CONTENT','OMP_PROFILE','PI_PROFILE']) {
        if (typeof original[key] === 'string') restored[key] = original[key]; else delete restored[key];
      }
    } catch { throw new Error('Invalid original UI environment; cannot safely restore role isolation'); }
  }
  for (const key of ['PASEO_FACTORY_UI_HOME','PASEO_FACTORY_IMPECCABLE','PASEO_FACTORY_UI_BASE_ENV']) delete restored[key];
  return restored;
}
