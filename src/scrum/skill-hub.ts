/** Local capability inventory and the shared Project role-skill policy. Discovery never executes host code. */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  cpSync,
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
import { SCRUM_ROLE_SKILLS } from "./prompts.ts";
import type { ScrumRoleName } from "./config.ts";

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
  projectRoot?: string;
  configuredPacks?: string[];
}): string[] {
  return (
    options.configuredPacks ?? detectProjectSkillPacks(options.projectRoot)
  );
}

export interface ProjectSkillContext {
  projectRoot?: string;
  userHome?: string;
  configuredPacks?: string[];
  slpLanes?: { supervisor: string; lead: string; worker: string };
  contractGrants?: Array<{
    task: string;
    role: ScrumRoleName;
    skills: string[];
  }>;
}
export interface RoleSkillOptions extends ProjectSkillContext {
  role: ScrumRoleName | "supervisor" | "lead" | "peer";
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
export function resolveRoleSkillsForProject(
  options: RoleSkillOptions,
): string[] {
  const { role } = options;
  const baseline =
    role === "supervisor"
      ? SLP_ROLE_SKILLS.supervisor
      : role === "lead"
        ? SLP_ROLE_SKILLS.lead
        : role === "peer"
          ? [...CORE_FACTORY_SKILLS]
          : SCRUM_ROLE_SKILLS[role];
  const packs = resolveProjectSkillPacks(options);
  const home = options.userHome ?? homedir();
  const lock = readSkillLockFile(home);
  const installed = inspectFactorySkillPack(home).installedSkills;
  const candidates = [
    ...new Set([...installed, ...(packs.includes("expo") ? EXPO_SKILLS : [])]),
  ];
  const domain =
    role === "pm" || role === "supervisor" || role === "lead"
      ? []
      : candidates.filter((name) => {
          const pack = skillPack(name, lock.skills[name]?.source);
          if (!packs.includes(pack)) return false;
          if (pack !== "expo" || role === "dev" || role === "peer") return true;
          if (role === "ux")
            return /overview|design|native-ui|expo-ui|animation|dom|web-to-native/.test(
              name,
            );
          if (role === "qa")
            return /overview|debugging|dev-client|^eas-/.test(name);
          return /overview|structure|router|data-fetching|module|upgrade|brownfield|^eas-/.test(
            name,
          );
        });
  return [
    ...new Set([...baseline, ...domain, ...(options.contractSkills ?? [])]),
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
export function discoverHostEcosystems(
  userHome = homedir(),
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
export function importHostSkillOrPack(options: {
  id: string;
  userHome?: string;
  runner?: CompanionToolRunner;
}) {
  const home = options.userHome ?? homedir();
  if (options.id === "expo:official-pack")
    return installOrUpdateExpoSkillPack({
      userHome: home,
      action: "update",
      runner: options.runner,
    });
  const entry = discoverHostEcosystems(home).find((e) => e.id === options.id);
  if (!entry?.path)
    return { ok: false as const, reason: "Unknown host skill or pack" };
  const paths = walkSkills(entry.path),
    lock = readSkillLockFile(home);
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
  const now = new Date().toISOString();
  for (const path of [...paths].sort().reverse()) {
    const name = basename(path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    const dest = join(home, ".agents/skills", name);
    // Import preserves existing canonical skills; updates use their own source installer.
    if (existsSync(join(dest, "SKILL.md"))) continue;
    mkdirSync(dest, { recursive: true });
    cpSync(path, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !IMPORT_EXCLUDED_NAMES.has(basename(src)),
    });
    lock.skills[name] = {
      source: `${entry.ecosystem}/${entry.name}`,
      sourceType: "local",
      sourceUrl: path,
      skillFolderHash: createHash("sha256")
        .update(readFileSync(join(dest, "SKILL.md")))
        .digest("hex"),
      installedAt: now,
      updatedAt: now,
    };
  }
  writeSkillLockFile(home, lock);
  ensureProviderSkillSymlinks(home);
  return { ok: true as const, summary: `Imported ${entry.name} into Factory` };
}
export function buildRoleSkillMatrix(options: ProjectSkillContext = {}) {
  const installed = inspectFactorySkillPack(options.userHome).installedSkills;
  const roles = [
    "supervisor",
    "lead",
    "peer",
    "pm",
    "ux",
    "architect",
    "dev",
    "qa",
  ] as const;
  return roles.map((role) => {
    const isSlp = ["supervisor", "lead", "peer"].includes(role);
    const lane =
      role === "supervisor"
        ? options.slpLanes?.supervisor
        : role === "lead"
          ? options.slpLanes?.lead
          : role === "peer"
            ? options.slpLanes?.worker
            : undefined;
    const isPi = !lane || /^(pi|omp)\//.test(lane);
    const taskGrants = isSlp
      ? []
      : (options.contractGrants ?? []).filter((g) => g.role === role);
    const skills =
      role === "supervisor" && isPi
        ? [...installed]
        : role === "peer"
          ? installed.filter((s) => s !== "factory")
          : resolveRoleSkillsForProject({
              ...options,
              role,
              contractSkills: taskGrants.flatMap((g) => g.skills),
            });
    return { role, mode: isSlp ? "slp" : "scrum", skills, taskGrants };
  });
}
export function inspectSkillHub(options: ProjectSkillContext = {}) {
  const home = options.userHome ?? homedir(),
    lock = readSkillLockFile(home);
  const installed = inspectFactorySkillPack(home).installedSkills;
  const detected = detectProjectSkillPacks(options.projectRoot),
    active = options.configuredPacks ?? detected;
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
    projectPacks: PROJECT_SKILL_PACKS.map((id, i) => ({
      id,
      label: PACK_LABELS[i]!,
      enabled: active.includes(id),
      autoDetected: detected.includes(id),
    })),
    hostCatalog: discoverHostEcosystems(home),
    roleMatrix,
  };
}
