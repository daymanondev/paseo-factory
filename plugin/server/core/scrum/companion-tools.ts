import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync, readFileSync, copyFileSync, statSync } from 'node:fs';
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
  readonly name: Exclude<(typeof CORE_FACTORY_SKILLS)[number], 'factory'>;
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
export function ensureProviderSkillSymlinks(userHome = homedir()): { linked: string[] } {
  const agentsSkillsDir = join(userHome, '.agents', 'skills');
  // Prune retired skills before early returns, including broken symlinks.
  for (const dir of [agentsSkillsDir, join(userHome, '.pi/agent/skills'), join(userHome, '.claude/skills'), join(userHome, '.gemini/config/skills')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^impeccable/i.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
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
  const hash = createHash('sha1');
  const walk = (dir: string, relPrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.DS_Store') continue;
      const fullPath = join(dir, entry.name);
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, rel);
      } else if (entry.isFile()) {
        hash.update(`${rel}\0`);
        hash.update(readFileSync(fullPath));
      }
    }
  };
  walk(skillDir, '');
  return hash.digest('hex');
}

/**
 * Installs or updates the 10 open-source skills in `CORE_SKILL_SOURCES` directly from
 * their canonical GitHub repositories (`mattpocock/skills`, `anthropics/skills`,
 * `vercel-labs/agent-skills`) into `<userHome>/.agents/skills/<skillName>`, reconciles
 * `/factory` (`ensureFactorySkillSafe`) when requested, updates `<userHome>/.agents/.skill-lock.json`,
 * and links provider skill directories (`~/.pi/agent/skills`, `~/.claude/skills`, `~/.gemini/config/skills`).
 */
export function installOrUpdateFactorySkillPack(options?: {
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
      ? [...CORE_SKILL_SOURCES]
      : CORE_SKILL_SOURCES.filter((entry) => !existsSync(join(agentsSkillsDir, entry.name, 'SKILL.md')));

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
      if (existsSync(join(tmpDir, '.git'))) {
        const revRes = runner('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, env });
        const parsedSha = revRes.stdout.trim().split(/\s+/)[0]?.trim() ?? '';
        if (/^[0-9a-f]{7,40}$/i.test(parsedSha)) {
          repoCommitSha = parsedSha;
        }
      } else {
        const stdoutSha = cloneRes.stdout.trim().match(/\b([0-9a-f]{7,40})\b/i)?.[1];
        if (stdoutSha) repoCommitSha = stdoutSha;
      }

      const nowIso = new Date().toISOString();
      for (const entry of entries) {
        const srcSkillDir = join(tmpDir, entry.skillPath);
        if (!existsSync(join(srcSkillDir, 'SKILL.md'))) continue;
        const destSkillDir = join(agentsSkillsDir, entry.name);
        if (action === 'update') {
          rmSync(destSkillDir, { recursive: true, force: true });
        }
        copyDirectoryTreeSync(srcSkillDir, destSkillDir);
        const folderHash = computeSkillFolderHash(destSkillDir);
        const existingLock = lock.skills[entry.name];
        lock.skills[entry.name] = {
          source: entry.source,
          sourceType: 'github',
          sourceUrl: entry.sourceUrl,
          skillPath: `${entry.skillPath}/SKILL.md`,
          skillFolderHash: folderHash,
          ...(repoCommitSha ? { repoCommitSha } : existingLock?.repoCommitSha ? { repoCommitSha: existingLock.repoCommitSha } : {}),
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
  if (after.totalSkills === 0) {
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
  let packUpdateAvailable = pack.status === 'partial';
  if (pack.status !== 'not_installed') {
    const seenUrls = new Set<string>();
    for (const source of CORE_SKILL_SOURCES) {
      if (seenUrls.has(source.sourceUrl)) continue;
      seenUrls.add(source.sourceUrl);
      const lsRes = runner('git', ['ls-remote', source.sourceUrl, 'HEAD'], { cwd: userHome, env });
      if (lsRes.status !== 0) continue;
      const remoteSha = lsRes.stdout.trim().split(/\s+/)[0]?.trim() ?? '';
      if (!/^[0-9a-f]{7,40}$/i.test(remoteSha)) continue;
      const shortRemote = remoteSha.slice(0, 7);
      if (packLatest === null) packLatest = shortRemote;
      const repoSkills = CORE_SKILL_SOURCES.filter((s) => s.sourceUrl === source.sourceUrl);
      for (const skill of repoSkills) {
        if (!pack.installedSkills.includes(skill.name)) {
          packUpdateAvailable = true;
          packLatest = shortRemote;
          continue;
        }
        const entry = lock.skills[skill.name];
        const recordedCommit = entry?.repoCommitSha?.trim();
        if (recordedCommit && !remoteSha.startsWith(recordedCommit) && !recordedCommit.startsWith(shortRemote)) {
          packUpdateAvailable = true;
          packLatest = shortRemote;
        }
      }
    }
  }

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
