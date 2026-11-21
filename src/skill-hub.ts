import { listSkillPacks } from './skill-packs.ts';
import { readProjectSettings } from './project-settings.ts';
import { resolveProject } from './project.ts';
import { derivePaseoHomeFromStateDir, detectMobilePlatforms, discoverReleaseLabInstall } from './store-release-probe.ts';
/** Local capability inventory and the shared Project role-skill policy. Discovery never executes host code. */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join, basename, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
  CORE_FACTORY_SKILLS,
  EXPO_SKILLS,
  inspectFactorySkillPack,
  readSkillLockFile,
  writeSkillLockFile,
  ensureProviderSkillSymlinks,
  providerSkillDirectories,
  installOrUpdateExpoSkillPack,
} from "./companion-tools.ts";
import type { CompanionToolRunner } from "./companion-tools.ts";

export const PROJECT_SKILL_PACKS = [
  "expo",
  "firebase",
  "zcode-3d",
  "science",
] as const;
const PACK_LABELS = [
  "Expo & React Native",
  "Firebase & Firestore",
  "3D & Game Engines",
  "Science & Bioinformatics",
];
function json(path: string): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
export function detectProjectSkillPacks(projectRoot?: string): string[] {
  if (!projectRoot) return [];
  const pkg = json(join(projectRoot, "package.json"));
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const files = existsSync(projectRoot) ? readdirSync(projectRoot) : [];
  return [
    ...(Object.hasOwn(json(join(projectRoot, "app.json")), "expo") ||
    files.includes("eas.json") ||
    ["expo", "react-native", "expo-router"].some((key) => key in deps)
      ? ["expo"]
      : []),
    ...(files.some((f) =>
      ["firebase.json", ".firebaserc", "firestore.rules"].includes(f),
    ) ||
    ["firebase", "firebase-admin", "@react-native-firebase/app"].some(
      (key) => key in deps,
    )
      ? ["firebase"]
      : []),
    ...(files.some((f) => f === "project.godot" || f.endsWith(".uproject"))
      ? ["zcode-3d"]
      : []),
  ];
}
function skillPack(name: string, source = ""): string {
  if ((CORE_FACTORY_SKILLS as readonly string[]).includes(name)) return "core";
  if (/^(expo-|eas-)/i.test(name) || source.includes("expo/skills"))
    return "expo";
  if (/firebase|firestore/i.test(name + source)) return "firebase";
  if (/zcode-3d|threejs|godot|unity|unreal|3d/i.test(name + source))
    return "zcode-3d";
  if (/science|bioinformatics|protein|genomic/i.test(name + source))
    return "science";
  return source ? "workflow" : "custom";
}
export function resolveProjectSkillPacks(options: {
  stateDir?: string;
  projectRoot?: string;
  configuredPacks?: string[];
}): string[] {
  if (options.configuredPacks === undefined && options.stateDir && options.projectRoot) {
    const project = resolveProject(options.projectRoot);
    if (project.ok) options = { ...options, configuredPacks: readProjectSettings(options.stateDir, project.slug).skillPacks };
  }
  return (
    options.configuredPacks ?? detectProjectSkillPacks(options.projectRoot)
  );
}

export interface ProjectSkillContext {
  stateDir?: string;
  paseoHome?: string;
  projectRoot?: string;
  userHome?: string;
  configuredPacks?: string[];
  contractSkills?: string[];
  slpLanes?: { supervisor: string; lead: string; worker: string };
}
export interface RoleSkillOptions extends ProjectSkillContext {
  role: "supervisor" | "lead" | "peer";
  contractSkills?: string[];
}
export const SLP_ROLE_SKILLS = {
  supervisor: [
    "grilling",
    "domain-modeling",
    "grill-with-docs",
    "research",
    "factory",
  ],
  lead: ["codebase-design", "domain-modeling", "tdd"],
} as const;

function resolvePaseoHomeForSkillHub(userHome: string, paseoHome?: string, stateDir?: string): string {
  if (paseoHome !== undefined && paseoHome.trim() !== "") return paseoHome.trim();
  return derivePaseoHomeFromStateDir(stateDir) ?? join(userHome, ".paseo");
}

function isMobileStoreProject(projectRoot?: string): boolean {
  if (!projectRoot) return false;
  return detectMobilePlatforms(projectRoot).length > 0 || existsSync(join(projectRoot, ".store-release", "manifest.json"));
}

export function resolveRoleSkillsForProject(
  options: RoleSkillOptions,
): string[] {
  const { role } = options;
  if (role === "lead") return [...SLP_ROLE_SKILLS.lead];
  if (role === "supervisor") return inspectFactorySkillPack(options.userHome).installedSkills;
  const baseline = [...CORE_FACTORY_SKILLS];
  const domain = role === 'peer' ? projectSkillPackInventory(options).filter(p => p.enabled).flatMap(p => p.skills) : [];
  const mobileStoreSkills =
    role === "peer" &&
    isMobileStoreProject(options.projectRoot) &&
    inspectFactorySkillPack(options.userHome).installedSkills.includes("mobile-store-release")
      ? ["mobile-store-release"]
      : [];
  return [
    ...new Set([...baseline, ...domain, ...mobileStoreSkills, ...(options.contractSkills ?? [])]),
  ].filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name));
}

export interface HostCatalogEntry {
  id: string;
  name: string;
  ecosystem: string;
  path: string | null;
  skills: string[];
  status: "linked" | "available";
  kind: "skill" | "pack" | "plugin";
  mcpServers: string[];
}
function walkSkills(
  root: string,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (depth > 8 || !existsSync(root)) return [];
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return [];
  }
  if (seen.has(real)) return [];
  seen.add(real);
  if (existsSync(join(root, "SKILL.md"))) return [root];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          e.name !== "node_modules" &&
          (e.isDirectory() || e.isSymbolicLink()),
      )
      .flatMap((e) => walkSkills(join(root, e.name), depth + 1, seen));
  } catch {
    return [];
  }
}
function discoverHostMcpNames(root: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(root)) return [];
  const names = [
    ".mcp.json",
    "mcp.json",
    "mcp_config.json",
    "plugin.json",
    ".claude-plugin/plugin.json",
  ].flatMap((file) => Object.keys(json(join(root, file)).mcpServers ?? {}));
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      )
        names.push(...discoverHostMcpNames(join(root, entry.name), depth + 1));
    }
  } catch {
    /* partial host installations remain discoverable */
  }
  return [...new Set(names)];
}
function resolveReleaseLabSkillRoot(paseoHome: string): string | null {
  const install = discoverReleaseLabInstall(paseoHome);
  return install.installed && install.enabled ? install.skillRoot : null;
}

export function discoverHostEcosystems(
  userHome = homedir(),
  paseoHome?: string,
): HostCatalogEntry[] {
  const installed = new Set(inspectFactorySkillPack(userHome).installedSkills);
  const lock = readSkillLockFile(userHome);
  const mirrorSkillRoots = new Set([
    ".zcode/skills",
    ".claude/skills",
    ".codex/skills",
    ".pi/agent/skills",
  ]);
  const result: HostCatalogEntry[] = [
    {
      id: "expo:official-pack",
      name: "Official Expo & EAS",
      ecosystem: "GitHub Catalog (expo/skills)",
      path: null,
      skills: [...EXPO_SKILLS],
      status: EXPO_SKILLS.every((s) => installed.has(s))
        ? "linked"
        : "available",
      kind: "pack",
      mcpServers: ["expo-mcp"],
    },
  ];
  const releaseLabSkillRoot = resolveReleaseLabSkillRoot(resolvePaseoHomeForSkillHub(userHome, paseoHome));
  if (releaseLabSkillRoot !== null) {
    const paths = walkSkills(releaseLabSkillRoot);
    const skills = [...new Set(paths.map((p) => basename(p)))];
    if (skills.length > 0) {
      result.push({
        id: "paseo:factory-release-lab",
        name: "factory-release-lab",
        ecosystem: "paseo",
        path: releaseLabSkillRoot,
        skills,
        kind: paths.length === 1 && paths[0] === releaseLabSkillRoot ? "skill" : "pack",
        mcpServers: [],
        status: skills.every((s) => installed.has(s)) ? "linked" : "available",
      });
    }
  }
  const builtin = join(userHome, ".codex/skills/.system");
  if (existsSync(builtin)) {
    const skills = walkSkills(builtin).map((path) => basename(path));
    result.push({
      id: "codex:builtin",
      name: "Codex built-in skills",
      ecosystem: "codex",
      path: builtin,
      skills,
      status:
        skills.length > 0 && skills.every((s) => installed.has(s))
          ? "linked"
          : "available",
      kind: "pack",
      mcpServers: [],
    });
  }
  const roots = [
    ["zcode", ".zcode/skills"],
    ["zcode", ".zcode/cli/plugins/cache/zcode-plugins-official"],
    ["zcode", ".zcode/plugins/cache/zcode-official-plugin"],
    ["antigravity", ".gemini/config/plugins"],
    ["antigravity", ".gemini/antigravity/builtin/skills"],
    ["claude", ".claude/plugins/marketplaces/claude-plugins-official/plugins"],
    [
      "claude",
      ".claude/plugins/marketplaces/claude-plugins-official/external_plugins",
    ],
    ["claude", ".claude/skills"],
    ["codex", ".codex/plugins/cache"],
    ["codex", ".codex/skills"],
    ["codex", ".codex/.sandbox-bin"],
    ["pi", ".pi/agent/git"],
    ["pi", ".pi/agent/skills"],
  ];
  for (const [ecosystem, relative] of roots) {
    const root = join(userHome, relative!);
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => !n.startsWith(".") && !/^impeccable/i.test(n))) {
      if (
        mirrorSkillRoots.has(relative!) &&
        installed.has(name) &&
        lock.skills[name]?.source !== `${ecosystem}/${name}`
      ) {
        continue;
      }
      const path = join(root, name),
        paths = walkSkills(path);
      const mcpServers = discoverHostMcpNames(path);
      if (!paths.length && !mcpServers.length) continue;
      const skills = [...new Set(paths.map((p) => basename(p)))];
      const baseId = `${ecosystem}:${name}`;
      const id = result.some((e) => e.id === baseId)
        ? `${baseId}:${relative}`
        : baseId;
      result.push({
        id,
        name,
        ecosystem: ecosystem!,
        path,
        skills,
        kind:
          paths.length === 1 && paths[0] === path
            ? "skill"
            : paths.length
              ? "pack"
              : "plugin",
        mcpServers,
        status:
          skills.length > 0 && skills.every((s) => installed.has(s))
            ? "linked"
            : "available",
      });
    }
  }
  return result;
}
const IMPORT_EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

function validatePortableTree(
  path: string,
  root = realpathSync(path),
  visited = new Set<string>(),
): void {
  const real = realpathSync(path),
    rel = relative(root, real);
  if (
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel)
  )
    throw new Error(`Skill support files escape the selected skill: ${path}`);
  if (visited.has(real)) throw new Error(`Cyclic skill support link: ${path}`);
  visited.add(real);
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries) {
      if (IMPORT_EXCLUDED_NAMES.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink() || entry.isDirectory())
        validatePortableTree(child, root, visited);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
  }
  visited.delete(real);
}
function installSkillDirsToAgents(options: {
  home: string;
  paths: readonly string[];
  source: string;
  updateSameSource: boolean;
}): { synced: string[]; lockUpdated: boolean } {
  const lock = readSkillLockFile(options.home);
  const now = new Date().toISOString();
  const synced: string[] = [];
  let lockUpdated = false;
  for (const path of options.paths) {
    const name = basename(path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    const dest = join(options.home, ".agents", "skills", name);
    const destSkillMd = join(dest, "SKILL.md");
    const srcHash = createHash("sha256").update(readFileSync(join(path, "SKILL.md"))).digest("hex");
    const existingEntry = lock.skills[name];
    if (existsSync(destSkillMd)) {
      if (!options.updateSameSource || existingEntry?.source !== options.source) continue;
      const destHash = createHash("sha256").update(readFileSync(destSkillMd)).digest("hex");
      if (destHash === srcHash) {
        synced.push(name);
        continue;
      }
      rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });
    cpSync(path, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !IMPORT_EXCLUDED_NAMES.has(basename(src)),
    });
    lock.skills[name] = {
      source: options.source,
      sourceType: "local",
      sourceUrl: path,
      skillFolderHash: srcHash,
      installedAt: existingEntry?.installedAt ?? now,
      updatedAt: now,
    };
    lockUpdated = true;
    synced.push(name);
  }
  if (lockUpdated) writeSkillLockFile(options.home, lock);
  ensureProviderSkillSymlinks(options.home);
  return { synced, lockUpdated };
}

export function importHostSkillOrPack(options: {
  id: string;
  userHome?: string;
  paseoHome?: string;
  runner?: CompanionToolRunner;
}) {
  const home = options.userHome ?? homedir();
  if (options.id === "expo:official-pack")
    return installOrUpdateExpoSkillPack({
      userHome: home,
      action: "update",
      runner: options.runner,
    });
  const entry = discoverHostEcosystems(home, options.paseoHome).find((e) => e.id === options.id);
  if (!entry?.path)
    return { ok: false as const, reason: "Unknown host skill or pack" };
  const paths = walkSkills(entry.path);
  if (!paths.length)
    return {
      ok: false as const,
      reason: "This host plugin contains no portable skills",
    };
  try {
    for (const path of paths) validatePortableTree(path);
  } catch (error) {
    return { ok: false as const, reason: String(error) };
  }
  installSkillDirsToAgents({
    home,
    paths: [...paths].sort().reverse(),
    source: `${entry.ecosystem}/${entry.name}`,
    updateSameSource: false,
  });
  return { ok: true as const, summary: `Imported ${entry.name} into Factory` };
}

/**
 * Reconciles companion plugin skills (e.g. `mobile-store-release` from an
 * installed `factory-release-lab` plugin) into `<userHome>/.agents/skills/` and
 * provider skill directories without vendoring external skill Markdown in
 * `paseo-factory`. Safe & non-fatal when roots are absent or unwritable.
 */
export function ensureCompanionPluginSkills(
  options: { userHome?: string; paseoHome?: string; stateDir?: string } = {},
  onWarn?: (message: string) => void,
): string[] {
  const userHome = options.userHome ?? homedir();
  const paseoHome = resolvePaseoHomeForSkillHub(userHome, options.paseoHome, options.stateDir);
  const releaseLabSkillRoot = resolveReleaseLabSkillRoot(paseoHome);
  if (releaseLabSkillRoot === null) return [];

  const paths = walkSkills(releaseLabSkillRoot);
  if (paths.length === 0) return [];

  try {
    for (const path of paths) validatePortableTree(path);
    return installSkillDirsToAgents({
      home: userHome,
      paths,
      source: "paseo/factory-release-lab",
      updateSameSource: true,
    }).synced;
  } catch (err) {
    onWarn?.(`skill: could not reconcile companion plugin skills — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
export function buildRoleSkillMatrix(options: ProjectSkillContext = {}) {
  const installed = inspectFactorySkillPack(options.userHome).installedSkills;
  const roles = ["supervisor", "lead", "peer"] as const;
  return roles.map((role) => {
    const lane =
      role === "supervisor"
        ? options.slpLanes?.supervisor
        : role === "lead"
          ? options.slpLanes?.lead
          : role === "peer"
            ? options.slpLanes?.worker
            : undefined;
    const isPi = !lane || /^(pi|omp)\//.test(lane);
    const skills =
      role === "supervisor" && isPi
        ? [...installed]
        : role === "peer"
          ? resolveRoleSkillsForProject({ ...options, role }).filter(s => installed.includes(s))
          : resolveRoleSkillsForProject({ ...options, role });
    return { role, skills };
  });
}
/** One registry powers both the inventory and the runtime allowlist. */
export function projectSkillPackInventory(options: ProjectSkillContext = {}) {
  const home = options.userHome ?? homedir(), lock = readSkillLockFile(home);
  const installed = inspectFactorySkillPack(home).installedSkills;
  const active = resolveProjectSkillPacks(options), detected = detectProjectSkillPacks(options.projectRoot);
  const packs: { id: string; label: string; kind: 'builtin' | 'source' | 'custom'; skills: string[]; description?: string }[] = PROJECT_SKILL_PACKS.map((id, i) => ({ id, label: PACK_LABELS[i]!, kind: 'builtin', skills: installed.filter(name => skillPack(name, lock.skills[name]?.source) === id) }));
  const sources = new Map<string, string[]>();
  for (const name of installed) {
    const source = lock.skills[name]?.source ?? 'Local/Custom';
    if (['core', ...PROJECT_SKILL_PACKS].includes(skillPack(name, lock.skills[name]?.source))) continue;
    const members = sources.get(source) ?? []; members.push(name); sources.set(source, members);
  }
  for (const [source, skills] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const id = 'source-' + source.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) + '-' + createHash('sha256').update(source).digest('hex').slice(0, 8);
    packs.push({ id, label: source, kind: 'source', skills });
  }
  if (options.stateDir) for (const pack of listSkillPacks(options.stateDir)) packs.push({ id: pack.id, label: pack.name, kind: 'custom', description: pack.description, skills: pack.skills });
  return packs.map(pack => ({ ...pack, installedCount: pack.skills.filter(s => installed.includes(s)).length, enabled: active.includes(pack.id), autoDetected: detected.includes(pack.id) }));
}

export function inspectSkillHub(options: ProjectSkillContext = {}) {
  const home = options.userHome ?? homedir(),
    lock = readSkillLockFile(home);
  const installed = inspectFactorySkillPack(home).installedSkills;
  const projectPacks = projectSkillPackInventory(options);
  const cache =
    json(join(home, ".agents/.skill-updates-cache.json")).remoteCommits ?? {};
  const roleMatrix = buildRoleSkillMatrix(options);
  const installedSkills = installed.map((name) => {
    const entry = lock.skills[name];
    const freshness =
      !entry || !/^https?:/.test(entry.sourceUrl)
        ? ("local" as const)
        : !entry.repoCommitSha ||
            (cache[entry.sourceUrl] &&
              cache[entry.sourceUrl] !== entry.repoCommitSha)
          ? ("update_available" as const)
          : ("up_to_date" as const);
    const harnesses = ["Pi", "Claude", "Antigravity", "Codex"].map(
      (harness) => {
        const dir = providerSkillDirectories(home)[harness];
        let healthy = false;
        try {
          healthy =
            !!dir &&
            realpathSync(join(dir, name)) ===
              realpathSync(join(home, ".agents/skills", name));
        } catch {
          /* missing */
        }
        return { name: harness, healthy, available: !!dir };
      },
    );
    return {
      name,
      pack: skillPack(name, entry?.source),
      packs: projectPacks.filter(p => p.skills.includes(name)).map(p => p.id),
      source: entry?.source ?? "Local/Custom",
      revision: entry?.repoCommitSha ?? null,
      freshness,
      harnesses,
      roles: roleMatrix
        .filter((r) => r.skills.includes(name))
        .map((r) => r.role),
    };
  });
  return {
    totalInstalled: installed.length,
    upToDateCount: installedSkills.filter((s) => s.freshness === "up_to_date")
      .length,
    updateAvailableCount: installedSkills.filter(
      (s) => s.freshness === "update_available",
    ).length,
    localCustomCount: installedSkills.filter((s) => s.freshness === "local")
      .length,
    symlinkDriftCount: installedSkills.filter((s) =>
      s.harnesses.some((h) => h.available && !h.healthy),
    ).length,
    installedSkills,
    projectPacks,
    skillPacksExplicit: options.configuredPacks !== undefined || !!(options.stateDir && options.projectRoot && (() => { const project = resolveProject(options.projectRoot); return project.ok && readProjectSettings(options.stateDir!, project.slug).skillPacks !== undefined; })()),
    hostCatalog: discoverHostEcosystems(home, resolvePaseoHomeForSkillHub(home, options.paseoHome, options.stateDir)),
    roleMatrix,
  };
}
