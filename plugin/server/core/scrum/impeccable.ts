import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, rmSync, writeFileSync, lstatSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FactoryError } from '../errors.ts';
import { ensureFactorySkillSafe } from '../skill.ts';

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
  id: 'impeccable' | 'factory-skills-pack';
  currentRevision: string | null;
  latestRevision: string | null;
  updateAvailable: boolean;
}

/**
 * Checks remote updates for `impeccable` (`npm view impeccable version`) and
 * `factory-skills-pack` (`git ls-remote <sourceUrl> HEAD` across `CORE_SKILL_SOURCES`
 * compared against `<userHome>/.agents/.skill-lock.json` and missing core skills).
 */
export function checkCompanionToolsUpdates(options?: {
  userHome?: string;
  runner?: CompanionToolRunner;
}): Record<'impeccable' | 'factory-skills-pack', CompanionToolUpdateStatus> {
  const userHome = options?.userHome ?? homedir();
  const runner = options?.runner ?? defaultCompanionToolRunner;
  const env = buildToolInstallEnv(userHome);

  // 1. Impeccable remote npm check
  const imp = inspectImpeccableTool(userHome);
  let impLatest: string | null = imp.status === 'outdated' ? IMPECCABLE_MIN_VERSION : imp.version;
  let impUpdateAvailable = imp.status === 'outdated';
  if (imp.status !== 'not_installed') {
    const npmRes = runner('npm', ['view', 'impeccable', 'version'], { cwd: userHome, env });
    if (npmRes.status === 0) {
      const candidate = npmRes.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
      if (/^[0-9]+\.[0-9]+\.[0-9]+/.test(candidate)) {
        impLatest = candidate;
        if (compareSemver(candidate, imp.version ?? '0.0.0') > 0) {
          impUpdateAvailable = true;
        }
      }
    }
  }

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
    impeccable: {
      id: 'impeccable',
      currentRevision: imp.version,
      latestRevision: impLatest,
      updateAvailable: impUpdateAvailable,
    },
    'factory-skills-pack': {
      id: 'factory-skills-pack',
      currentRevision: pack.revision,
      latestRevision: packLatest,
      updateAvailable: packUpdateAvailable,
    },
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
