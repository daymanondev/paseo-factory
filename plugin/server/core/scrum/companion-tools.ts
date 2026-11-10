import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync, readFileSync, copyFileSync, statSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { ensureFactorySkillSafe } from '../skill.ts';


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
  'research',
  'factory',
] as const;

export interface CoreSkillSource {
  readonly name: string;
  readonly source: string;
  readonly sourceUrl: string;
  readonly skillPath: string;
}

/**
 * Declarative registry of the 10 open-source skills required by `paseo-factory`
 * (`ADR 0036 §1`). `paseo-factory` never vendors third-party skill Markdown inside
 * its own repository; instead it remembers each skill's canonical GitHub origin
 * and installs/updates directly from GitHub into `<userHome>/.agents/skills/<name>`.
 */
export const CORE_SKILL_SOURCES: readonly CoreSkillSource[] = [
  {
    name: 'tdd',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/tdd',
  },
  {
    name: 'diagnosing-bugs',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/diagnosing-bugs',
  },
  {
    name: 'codebase-design',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/codebase-design',
  },
  {
    name: 'code-review',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/code-review',
  },
  {
    name: 'domain-modeling',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/domain-modeling',
  },
  {
    name: 'grill-with-docs',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/grill-with-docs',
  },
  {
    name: 'grilling',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/productivity/grilling',
  },
  {
    name: 'research',
    source: 'mattpocock/skills',
    sourceUrl: 'https://github.com/mattpocock/skills.git',
    skillPath: 'skills/engineering/research',
  },
  {
    name: 'frontend-design',
    source: 'anthropics/skills',
    sourceUrl: 'https://github.com/anthropics/skills.git',
    skillPath: 'skills/frontend-design',
  },
  {
    name: 'web-design-guidelines',
    source: 'vercel-labs/agent-skills',
    sourceUrl: 'https://github.com/vercel-labs/agent-skills.git',
    skillPath: 'skills/web-design-guidelines',
  },
] as const;

export interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash: string;
  repoCommitSha?: string;
  installedAt: string;
  updatedAt: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
  dismissed?: Record<string, unknown>;
  lastSelectedAgents?: string[];
}

export function readSkillLockFile(userHome = homedir()): SkillLockFile {
  const lockPath = join(userHome, '.agents', '.skill-lock.json');
  if (!existsSync(lockPath)) {
    return { version: 3, skills: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<SkillLockFile>;
    const skills =
      parsed && typeof parsed.skills === 'object' && parsed.skills !== null && !Array.isArray(parsed.skills)
        ? (parsed.skills as Record<string, SkillLockEntry>)
        : {};
    return {
      version: typeof parsed?.version === 'number' ? parsed.version : 3,
      skills: { ...skills },
      ...(parsed?.dismissed !== undefined ? { dismissed: parsed.dismissed } : {}),
      ...(Array.isArray(parsed?.lastSelectedAgents) ? { lastSelectedAgents: parsed.lastSelectedAgents } : {}),
    };
  } catch {
    return { version: 3, skills: {} };
  }
}

export function writeSkillLockFile(userHome: string, lock: SkillLockFile): void {
  const lockPath = join(userHome, '.agents', '.skill-lock.json');
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

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

export interface FactorySkillPackInspection {
  status: 'installed' | 'partial' | 'not_installed';
  installedSkills: string[];
  missingCoreSkills: string[];
  installedCoreCount: number;
  totalSkills: number;
  revision: string | null;
  path: string;
}

/**
 * Inspects `<userHome>/.agents/skills` for the core Factory skill pack
 * (`tdd`, `diagnosing-bugs`, `codebase-design`, `frontend-design`, `research`, etc.)
 * and reads `<userHome>/.agents/.skill-lock.json` for the tracked revision SHA.
 */
export function inspectFactorySkillPack(userHome = homedir()): FactorySkillPackInspection {
  const skillsDir = join(userHome, '.agents', 'skills');
  if (!existsSync(skillsDir)) {
    return {
      status: 'not_installed',
      installedSkills: [],
      missingCoreSkills: [...CORE_FACTORY_SKILLS],
      installedCoreCount: 0,
      totalSkills: 0,
      revision: null,
      path: skillsDir,
    };
  }
  const installedSkills: string[] = [];
  try {
    for (const name of readdirSync(skillsDir)) {
      if (name.startsWith('.') || /^impeccable/.test(name)) continue;
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
  const installedCoreCount = CORE_FACTORY_SKILLS.length - missingCoreSkills.length;
  const status =
    installedSkills.length === 0
      ? 'not_installed'
      : missingCoreSkills.length === 0
        ? 'installed'
        : 'partial';
  const lock = readSkillLockFile(userHome);
  let revision: string | null = null;
  for (const source of CORE_SKILL_SOURCES) {
    const entry = lock.skills[source.name];
    const sha = entry?.repoCommitSha?.trim() || entry?.skillFolderHash?.trim();
    if (sha) {
      revision = sha.slice(0, 7);
      break;
    }
  }
  return {
    status,
    installedSkills,
    missingCoreSkills,
    installedCoreCount,
    totalSkills: installedSkills.length,
    revision,
    path: skillsDir,
  };
}

/**
 * Ensures every skill directory in `<userHome>/.agents/skills/*` is symlinked
 * into `<userHome>/.pi/agent/skills/<name>`, `<userHome>/.claude/skills/<name>`,
 * and `<userHome>/.gemini/config/skills/<name>` (unless `~/.gemini/config/skills`
 * is already a directory symlink to `~/.agents/skills`).
 */
export function providerSkillDirectories(userHome: string): Record<string, string> {
  return Object.fromEntries([
    ['Pi', '.pi/agent/skills'], ['Claude', '.claude/skills'], ['Antigravity', '.gemini/config/skills'],
    ...['Codex'].filter(name => existsSync(join(userHome, '.' + name.toLowerCase()))).map(name => [name, '.' + name.toLowerCase() + '/skills']),
  ].map(([name, path]) => [name!, join(userHome, path!)]));
}
export function ensureProviderSkillSymlinks(userHome = homedir()): { linked: string[] } {
  const canonical = join(userHome, '.agents/skills');
  const targets = Object.values(providerSkillDirectories(userHome));
  for (const dir of [canonical, ...targets]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^(impeccable|critique$|audit$|polish$|normalize$|harden$|clarify$)/i.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  const linked: string[] = [];
  if (!existsSync(canonical)) return { linked };
  for (const target of targets) {
    if (existsSync(target) && realpathSync(target) === realpathSync(canonical)) continue;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(canonical)) {
      const src = join(canonical, name), dest = join(target, name);
      if (!existsSync(join(src, 'SKILL.md'))) continue;
      try { if (realpathSync(src) === realpathSync(dest)) continue; } catch { /* missing or broken link */ }
      rmSync(dest, { recursive: true, force: true });
      symlinkSync(src, dest, 'dir'); linked.push(dest);
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
    PATH: [...new Set(pathParts.join(delimiter).split(delimiter).filter(Boolean))].join(delimiter),
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

function copyDirectoryTreeSync(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryTreeSync(srcPath, destPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}

function computeSkillFolderHash(skillDir: string): string {
  return createHash('sha256').update(readFileSync(join(skillDir, 'SKILL.md'))).digest('hex');
}

/**
 * Installs or updates the 10 open-source skills in `CORE_SKILL_SOURCES` directly from
 * their canonical GitHub repositories (`mattpocock/skills`, `anthropics/skills`,
 * `vercel-labs/agent-skills`) into `<userHome>/.agents/skills/<skillName>`, reconciles
 * `/factory` (`ensureFactorySkillSafe`) when requested, updates `<userHome>/.agents/.skill-lock.json`,
 * and links provider skill directories (`~/.pi/agent/skills`, `~/.claude/skills`, `~/.gemini/config/skills`).
 */
export function installOrUpdateSourcesFromGit(sources: readonly CoreSkillSource[], options?: {
  userHome?: string;
  action?: 'install' | 'update';
  factoryCmd?: string;
  reconcileFactorySkill?: boolean;
  runner?: CompanionToolRunner;
}):
  | {
      ok: true;
      totalSkills: number;
      installedCoreCount: number;
      missingCoreSkills: string[];
      revision: string | null;
      summary: string;
    }
  | { ok: false; reason: string } {
  const userHome = options?.userHome ?? homedir();
  const action = options?.action ?? 'install';
  const runner = options?.runner ?? defaultCompanionToolRunner;
  const agentsSkillsDir = join(userHome, '.agents', 'skills');
  mkdirSync(agentsSkillsDir, { recursive: true });

  if (options?.reconcileFactorySkill === true) {
    ensureFactorySkillSafe(agentsSkillsDir, { factoryCmd: options.factoryCmd ?? 'factory' }, () => {});
  }

  const targetEntries =
    action === 'update'
      ? [...sources]
      : sources.filter((entry) => !existsSync(join(agentsSkillsDir, entry.name, 'SKILL.md')));

  const byRepo = new Map<string, CoreSkillSource[]>();
  for (const entry of targetEntries) {
    const group = byRepo.get(entry.sourceUrl) ?? [];
    group.push(entry);
    byRepo.set(entry.sourceUrl, group);
  }

  const env = buildToolInstallEnv(userHome);
  const lock = readSkillLockFile(userHome);
  let lockUpdated = false;
  const cloneErrors: string[] = [];

  for (const [sourceUrl, entries] of byRepo) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'factory-skills-'));
    try {
      const cloneRes = runner('git', ['clone', '--depth', '1', sourceUrl, tmpDir], { cwd: userHome, env });
      if (cloneRes.status !== 0) {
        const detail = [cloneRes.stderr.trim(), cloneRes.stdout.trim()].filter(Boolean).join(' — ') || `exit ${cloneRes.status}`;
        cloneErrors.push(`${entries[0]?.source ?? sourceUrl}: ${detail}`);
        continue;
      }
      let repoCommitSha: string | undefined;
      {
        const revRes = runner('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, env });
        const parsedSha = revRes.stdout.trim().split(/\s+/)[0]?.trim() ?? '';
        if (/^[0-9a-f]{7,40}$/i.test(parsedSha)) {
          repoCommitSha = parsedSha;
        }
      }
      if (!repoCommitSha) {
        const stdoutSha = cloneRes.stdout.trim().match(/\b([0-9a-f]{7,40})\b/i)?.[1];
        if (stdoutSha) repoCommitSha = stdoutSha;
      }

      if (!repoCommitSha) { cloneErrors.push(`Cannot resolve repository commit: ${sourceUrl}`); continue; }
      const nowIso = new Date().toISOString();
      for (const entry of entries) {
        const srcSkillDir = join(tmpDir, entry.skillPath);
        if (!existsSync(join(srcSkillDir, 'SKILL.md'))) { cloneErrors.push(`Missing upstream skill: ${entry.skillPath}`); continue; }
        const destSkillDir = join(agentsSkillsDir, entry.name);
        rmSync(destSkillDir, { recursive: true, force: true });
        copyDirectoryTreeSync(srcSkillDir, destSkillDir);
        const folderHash = computeSkillFolderHash(destSkillDir);
        const existingLock = lock.skills[entry.name];
        lock.skills[entry.name] = {
          source: entry.source,
          sourceType: 'github',
          sourceUrl: entry.sourceUrl,
          skillPath: `${entry.skillPath}/SKILL.md`,
          skillFolderHash: folderHash,
          ...(repoCommitSha ? { repoCommitSha } : {}),
          installedAt: existingLock?.installedAt ?? nowIso,
          updatedAt: nowIso,
        };
        lockUpdated = true;
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  if (lockUpdated) {
    writeSkillLockFile(userHome, lock);
  }
  const linked = ensureProviderSkillSymlinks(userHome);
  const after = inspectFactorySkillPack(userHome);
  if (cloneErrors.length > 0 || sources.some(entry => !existsSync(join(agentsSkillsDir, entry.name, 'SKILL.md')))) {
    return {
      ok: false,
      reason:
        cloneErrors.length > 0
          ? `factory-skills-pack ${action} failed (${cloneErrors.join('; ')})`
          : `factory-skills-pack ${action} produced no skills in ${agentsSkillsDir}`,
    };
  }
  const verb = action === 'update' ? 'Updated' : 'Synchronized';
  return {
    ok: true,
    totalSkills: after.totalSkills,
    installedCoreCount: after.installedCoreCount,
    missingCoreSkills: after.missingCoreSkills,
    revision: after.revision,
    summary: `${verb} Factory Core Skill Pack (${after.totalSkills} skill(s) in ~/.agents/skills, ${linked.linked.length} new symlink(s)).`,
  };
}

export interface CompanionToolUpdateStatus {
  id: 'factory-skills-pack';
  currentRevision: string | null;
  latestRevision: string | null;
  updateAvailable: boolean;
}

/**
 * Checks remote updates for `factory-skills-pack` (`git ls-remote <sourceUrl> HEAD` across `CORE_SKILL_SOURCES`
 * compared against `<userHome>/.agents/.skill-lock.json` and missing core skills).
 */
export function checkCompanionToolsUpdates(options?: {
  userHome?: string;
  runner?: CompanionToolRunner;
}): Record<'factory-skills-pack', CompanionToolUpdateStatus> {
  const userHome = options?.userHome ?? homedir();
  const runner = options?.runner ?? defaultCompanionToolRunner;
  const env = buildToolInstallEnv(userHome);

  // 2. Factory Core Skill Pack remote git ls-remote check
  const pack = inspectFactorySkillPack(userHome);
  const lock = readSkillLockFile(userHome);
  let packLatest: string | null = pack.revision;
  let remoteCommits: Record<string, string> = {};
  try {
    const cache = JSON.parse(readFileSync(join(userHome, '.agents/.skill-updates-cache.json'), 'utf8'));
    remoteCommits = Object.fromEntries(Object.entries(cache.remoteCommits ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { /* first check or damaged cache */ }
  let packUpdateAvailable = pack.status === 'partial' || Object.values(lock.skills).some(e => /^https?:/.test(e.sourceUrl) && (!e.repoCommitSha?.trim() || (remoteCommits[e.sourceUrl] !== undefined && remoteCommits[e.sourceUrl] !== e.repoCommitSha)));
  if (pack.status !== 'not_installed') {
    const seenUrls = new Set<string>();
    for (const source of [...CORE_SKILL_SOURCES, ...Object.values(lock.skills).filter(e => /^https?:/.test(e.sourceUrl))]) {
      if (seenUrls.has(source.sourceUrl)) continue;
      seenUrls.add(source.sourceUrl);
      const lsRes = runner('git', ['ls-remote', source.sourceUrl, 'HEAD'], { cwd: userHome, env });
      if (lsRes.status !== 0) continue;
      const remoteSha = lsRes.stdout.trim().split(/\s+/)[0]?.trim() ?? '';
      if (!/^[0-9a-f]{7,40}$/i.test(remoteSha)) continue;
      remoteCommits[source.sourceUrl] = remoteSha;
      const shortRemote = remoteSha.slice(0, 7);
      if (packLatest === null) packLatest = shortRemote;
      const repoSkills = [...new Set([...CORE_SKILL_SOURCES.filter(s => s.sourceUrl === source.sourceUrl).map(s => s.name), ...Object.entries(lock.skills).filter(([, e]) => e.sourceUrl === source.sourceUrl).map(([name]) => name)])].map(name => ({ name }));
      for (const skill of repoSkills) {
        if (!pack.installedSkills.includes(skill.name)) {
          packUpdateAvailable = true;
          packLatest = shortRemote;
          continue;
        }
        const entry = lock.skills[skill.name];
        const recordedCommit = entry?.repoCommitSha?.trim();
        if (!recordedCommit || recordedCommit !== remoteSha) {
          packUpdateAvailable = true;
          packLatest = shortRemote;
        }
      }
    }
  }

  mkdirSync(join(userHome, '.agents'), { recursive: true });
  writeFileSync(join(userHome, '.agents/.skill-updates-cache.json'), JSON.stringify({ checkedAt: new Date().toISOString(), remoteCommits }));
  return {
    'factory-skills-pack': {
      id: 'factory-skills-pack',
      currentRevision: pack.revision,
      latestRevision: packLatest,
      updateAvailable: packUpdateAvailable,
    },
  };
}

/** Remove Factory-owned overlays before changing identity or rebuilding a session. */
export function restoreLegacyUiEnvironment<T extends Record<string, string | undefined>>(environment: T): Record<string, string> {
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

export function installOrUpdateFactorySkillPack(options?: Parameters<typeof installOrUpdateSourcesFromGit>[1]) {
  const userHome = options?.userHome ?? homedir();
  const sources = [...CORE_SKILL_SOURCES, ...(existsSync(join(userHome, '.agents/skills/expo-overview/SKILL.md')) ? EXPO_SKILL_SOURCES : [])];
  if (options?.action === 'update') {
    for (const [name, entry] of Object.entries(readSkillLockFile(options.userHome).skills)) {
      if (sources.some(s => s.name === name) || !/^https:\/\//.test(entry.sourceUrl) || !entry.skillPath || entry.sourceType !== 'github') continue;
      const skillPath = entry.skillPath.replace(/\/SKILL\.md$/, '');
      if (skillPath.split(/[\\/]/).includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
      sources.push({ name, source: entry.source, sourceUrl: entry.sourceUrl, skillPath });
    }
  }
  return installOrUpdateSourcesFromGit(sources, options);
}
export const EXPO_STABLE_SKILLS = ['eas-app-stores', 'eas-hosting', 'eas-observe', 'eas-simulator', 'eas-update', 'eas-update-insights', 'eas-workflows', 'expo-animation', 'expo-app-clip', 'expo-brownfield', 'expo-data-fetching', 'expo-design-system', 'expo-dev-client', 'expo-dom', 'expo-examples', 'expo-module', 'expo-native-ui', 'expo-overview', 'expo-project-structure', 'expo-router', 'expo-ui', 'expo-upgrade', 'expo-web-to-native'] as const;
export const EXPO_EXPERIMENTAL_SKILLS = ['expo-migrate-module'] as const;
export const EXPO_SKILLS = [...EXPO_STABLE_SKILLS, ...EXPO_EXPERIMENTAL_SKILLS];
export const EXPO_SKILL_SOURCES: readonly CoreSkillSource[] = EXPO_SKILLS.map(name => ({ name, source: 'expo/skills', sourceUrl: 'https://github.com/expo/skills.git', skillPath: `plugins/${name === 'expo-migrate-module' ? 'expo-experiments' : 'expo'}/skills/${name}` }));
export function installOrUpdateExpoSkillPack(options?: Parameters<typeof installOrUpdateSourcesFromGit>[1]) {
  return installOrUpdateSourcesFromGit(EXPO_SKILL_SOURCES, options);
}
export { buildRoleSkillMatrix, resolveProjectSkillPacks, detectProjectSkillPacks, resolveRoleSkillsForProject, discoverHostEcosystems, importHostSkillOrPack, inspectSkillHub } from './skill-hub.ts';
