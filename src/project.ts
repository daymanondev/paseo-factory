/**
 * The canonical Project identity (v0.0.14, ADR 0010 §1/§5): any directory
 * inside a Git repository resolves to ONE Project — `root` (the top-level
 * checkout `git rev-parse --show-toplevel` names) plus a deterministic
 * `<project-slug> = <basename(root)>-<sha1(realpath(gitCommonDir)).slice(0,6)>`.
 * The basename distinguishes sibling checkouts; the hash anchors the slug to
 * the repository's common git dir, so a linked worktree resolves the main
 * repo's git dir and every checkout of one repository shares the hash half.
 * All per-Project factory state (ledger, reports, gate logs, retro files,
 * worktrees, the project's lanes.json override) lives under
 * `<stateDir>/projects/<slug>/` — cross-project pollution is a path bug, then.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, basename, join, parse, resolve } from "node:path";

/** Git plumbing is a fact about the checkout, so it gets the same short leash as the workspace calls. */
const GIT_TIMEOUT_MS = 10_000;

export type ProjectResolution =
  | { ok: true; root: string; gitCommonDir: string; slug: string }
  | { ok: false; reason: string };

export interface BootstrapProjectOptions {
  stateDir?: string;
  userHome?: string;
  paseoHome?: string;
  home?: string;
}

export type BootstrapProjectResolution =
  | {
      ok: true;
      root: string;
      gitCommonDir: string;
      slug: string;
      name: string;
      bootstrapped: boolean;
    }
  | {
      ok: false;
      code: "missing-directory" | "unsafe-directory" | "git-init-failed";
      cwd: string;
      reason: string;
    };

export interface DiscoveredProject {
  slug: string;
  name: string;
  root: string | null;
  commonDir: string;
  missingRoot?: boolean;
  supervisorId: string | null;
  leadId: string | null;
  activeTaskCount: number;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isUnsafeBootstrapDirectory(target: string, options?: BootstrapProjectOptions): string | null {
  const parsed = parse(target);
  if (target === parsed.root) {
    return `refusing to initialize Git at filesystem root (${target})`;
  }
  const sysHome = homedir();
  if (sysHome !== "" && (target === resolve(sysHome) || target === realpathSafe(sysHome))) {
    return `refusing to initialize Git directly in home directory (${target})`;
  }
  if (typeof options?.userHome === "string" && options.userHome.trim() !== "") {
    const uh = options.userHome.trim();
    if (target === resolve(uh) || target === realpathSafe(uh)) {
      return `refusing to initialize Git directly in user home directory (${target})`;
    }
  }
  const paseoHome = options?.paseoHome ?? options?.home;
  if (typeof paseoHome === "string" && paseoHome.trim() !== "") {
    const ph = paseoHome.trim();
    const resPh = resolve(ph);
    const normPh = realpathSafe(ph);
    if (target === resPh || target === normPh || target.startsWith(`${resPh}/`) || target.startsWith(`${normPh}/`)) {
      return `refusing to initialize Git inside Paseo home directory (${target})`;
    }
  }
  if (typeof options?.stateDir === "string" && options.stateDir.trim() !== "") {
    const sd = options.stateDir.trim();
    const resSd = resolve(sd);
    const normSd = realpathSafe(sd);
    if (target === resSd || target === normSd || target.startsWith(`${resSd}/`) || target.startsWith(`${normSd}/`)) {
      return `refusing to initialize Git inside Factory state directory (${target})`;
    }
  }
  if (target.includes("/plugin-state/paseo-factory")) {
    return `refusing to initialize Git inside Factory state directory (${target})`;
  }
  return null;
}

/**
 * Resolves `cwd` to its canonical Git Project, automatically bootstrapping a
 * greenfield non-Git folder (`git init` + initial empty commit) or an unborn
 * Git repository without `HEAD` so per-Task worktrees work immediately
 * (v0.0.35, ADR 0024). Refuses missing directories, `/`, `$HOME`, and paths
 * inside Factory's internal state directory.
 */
export function resolveOrBootstrapProject(cwd: string, options?: BootstrapProjectOptions): BootstrapProjectResolution {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    return { ok: false, code: "missing-directory", cwd: String(cwd ?? ""), reason: "project directory path cannot be empty" };
  }
  const abs = resolve(cwd.trim());
  if (!existsSync(abs)) {
    return { ok: false, code: "missing-directory", cwd: abs, reason: `directory ${abs} does not exist on disk` };
  }
  try {
    if (!statSync(abs).isDirectory()) {
      return { ok: false, code: "missing-directory", cwd: abs, reason: `${abs} is not a directory` };
    }
  } catch (err) {
    return { ok: false, code: "missing-directory", cwd: abs, reason: err instanceof Error ? err.message : String(err) };
  }
  const target = realpathSafe(abs);
  const unsafeReason = isUnsafeBootstrapDirectory(target, options) ?? isUnsafeBootstrapDirectory(abs, options);
  if (unsafeReason !== null) {
    return { ok: false, code: "unsafe-directory", cwd: target, reason: unsafeReason };
  }

  let resolved = resolveProject(target);
  let bootstrapped = false;
  if (!resolved.ok) {
    try {
      execFileSync("git", ["init"], {
        cwd: target,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      const first = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "";
      return {
        ok: false,
        code: "git-init-failed",
        cwd: target,
        reason: first !== "" ? first : err instanceof Error ? err.message : String(err),
      };
    }
    bootstrapped = true;
    resolved = resolveProject(target);
    if (!resolved.ok) {
      return { ok: false, code: "git-init-failed", cwd: target, reason: resolved.reason };
    }
  } else {
    const unsafeRootReason =
      isUnsafeBootstrapDirectory(realpathSafe(resolved.root), options) ??
      isUnsafeBootstrapDirectory(resolve(resolved.root), options);
    if (unsafeRootReason !== null) {
      return { ok: false, code: "unsafe-directory", cwd: resolved.root, reason: unsafeRootReason };
    }
  }

  let hasHead = false;
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: resolved.root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    hasHead = true;
  } catch {
    hasHead = false;
  }

  if (!hasHead) {
    try {
      execFileSync(
        "git",
        ["-c", "user.name=Factory", "-c", "user.email=factory@local", "commit", "--allow-empty", "-m", "chore: initialize repository"],
        {
          cwd: resolved.root,
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      bootstrapped = true;
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      const first = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "";
      return {
        ok: false,
        code: "git-init-failed",
        cwd: resolved.root,
        reason: first !== "" ? first : err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    ok: true,
    root: resolved.root,
    gitCommonDir: resolved.gitCommonDir,
    slug: resolved.slug,
    name: basename(resolved.root) || resolved.slug,
    bootstrapped,
  };
}

export const ensureGitRepository = resolveOrBootstrapProject;

/**
 * Resolves the canonical Project of `cwd` — any directory inside a Git
 * repository. Runs `git rev-parse --show-toplevel --git-common-dir` (the
 * common dir follows a linked worktree back to the main repository's git
 * dir), then hashes its realpath: `slug = <basename(root)>-<sha1(...).slice(0,6)>`.
 * A directory git cannot answer for is a named refusal, never a guess —
 * project-scoped state is opt-in on a resolved slug, so nothing downstream
 * falls back to a made-up identity.
 */
export function resolveProject(cwd: string): ProjectResolution {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const first = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "";
    return { ok: false, reason: first !== "" ? first : err instanceof Error ? err.message : String(err) };
  }
  const lines = stdout.trim().split("\n");
  const root = lines[0]?.trim() ?? "";
  const commonDirRaw = lines[1]?.trim() ?? "";
  if (root === "" || commonDirRaw === "") {
    return { ok: false, reason: `git did not answer --show-toplevel --git-common-dir for ${cwd}` };
  }
  // The common dir may be relative (`.git` for a main checkout) — and git
  // prints it relative to the INVOCATION cwd (`../.git` from a
  // subdirectory), so resolve against cwd, not the toplevel, before taking
  // its physical path.
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw);
  let gitCommonDir: string;
  try {
    gitCommonDir = realpathSync(commonDirAbs);
  } catch {
    return { ok: false, reason: `the git common dir ${commonDirAbs} of ${root} does not exist on disk` };
  }
  const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
  return { ok: true, root, gitCommonDir, slug: `${basename(root)}-${hash}` };
}

/** Where one Project's isolated factory state lives — `<stateDir>/projects/<slug>/`. */
export function projectStateDir(stateDir: string, projectSlug: string): string {
  return join(stateDir, "projects", projectSlug);
}

/**
 * The project registry (v0.0.14, ADR 0010 §1/§5, promoted into the core in
 * v0.0.18): every project the factory has seated records its identity in
 * `<stateDir>/projects/<slug>/project.json` — the durable `<project-slug>` →
 * `<project-root>` binding the surface's Project Selector lists and the
 * session-open env injection matches seat agent ids against. The registry is
 * a cache of identities the ledger and the daemon already hold; a missing or
 * corrupt file degrades to discovery from live seat agents, never to a wrong
 * guess.
 */

/**
 * The Lead rotation state machine's three states (v0.0.20, ADR 0013 §5):
 * `normal` — the mailbox drains per ticket 06; `rotation_pending` — the Lead
 * crossed `LEAD_ROTATE_TOKENS` mid-turn and the boundary waits; `handing_over`
 * — the mailbox is locked (arriving mail holds as `mail_queued`) while the
 * outgoing Lead runs its one Handoff Extraction turn and the successor spawns.
 * The state lives in `project.json` — absent reads as `normal`.
 */
export type LeadRotationState = "normal" | "rotation_pending" | "handing_over";

/** One project's registry entry — the root binding plus the seat agent ids, when seats live. */
export interface ProjectRegistration {
  slug: string;
  root: string;
  name?: string;
  commonDir?: string;
  supervisor?: string;
  lead?: string;
  /** The Lead rotation state's durable record (v0.0.20, ADR 0013 §5) — absent reads as "normal". */
  rotationState?: LeadRotationState;
  /** When the current handoff was requested (ISO 8601) — stamped entering "handing_over", cleared on reset. */
  handoffRequestedAt?: string;
  /** The Project's Paseo workspace id (v0.0.23, ADR 0015 §6). */
  workspaceId?: string;
  /** The Project's Paseo project id (v0.0.23, ADR 0015 §6). */
  paseoProjectId?: string;
  /** Active Task worktree Paseo workspace ids keyed by task id (v0.0.23, ADR 0015 §6). */
  taskWorkspaces?: Record<string, string>;
  /** Normal-chat agent ids that invoked `supervisor_dispatch` for this Project (v0.0.24, ADR 0015 §5). */
  dispatchers?: string[];
}

const LEAD_ROTATION_STATES: readonly string[] = ["normal", "rotation_pending", "handing_over"];

/** Reads `<stateDir>/projects/<slug>/project.json` — undefined when the project has no registry yet. */
export function readProjectRegistration(stateDir: string, slug: string): ProjectRegistration | undefined {
  const path = join(projectStateDir(stateDir, slug), "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectRegistration>;
    if (typeof parsed.root !== "string" || parsed.root === "") return undefined;
    const taskWorkspaces: Record<string, string> = {};
    if (parsed.taskWorkspaces !== undefined && parsed.taskWorkspaces !== null && typeof parsed.taskWorkspaces === "object" && !Array.isArray(parsed.taskWorkspaces)) {
      for (const [task, wsId] of Object.entries(parsed.taskWorkspaces)) {
        if (typeof wsId === "string" && wsId !== "") taskWorkspaces[task] = wsId;
      }
    }
    const dispatchers: string[] = [];
    if (Array.isArray(parsed.dispatchers)) {
      for (const id of parsed.dispatchers) {
        if (typeof id === "string" && id.trim() !== "" && !dispatchers.includes(id.trim())) {
          dispatchers.push(id.trim());
        }
      }
    }
    return {
      slug,
      root: parsed.root,
      ...(typeof parsed.name === "string" && parsed.name !== "" ? { name: parsed.name } : {}),
      ...(typeof parsed.commonDir === "string" && parsed.commonDir !== "" ? { commonDir: parsed.commonDir } : {}),
      ...(typeof parsed.supervisor === "string" && parsed.supervisor !== "" ? { supervisor: parsed.supervisor } : {}),
      ...(typeof parsed.lead === "string" && parsed.lead !== "" ? { lead: parsed.lead } : {}),
      ...(typeof parsed.rotationState === "string" && LEAD_ROTATION_STATES.includes(parsed.rotationState)
        ? { rotationState: parsed.rotationState as LeadRotationState }
        : {}),
      ...(typeof parsed.handoffRequestedAt === "string" && parsed.handoffRequestedAt !== "" ? { handoffRequestedAt: parsed.handoffRequestedAt } : {}),
      ...(typeof parsed.workspaceId === "string" && parsed.workspaceId !== "" ? { workspaceId: parsed.workspaceId } : {}),
      ...(typeof parsed.paseoProjectId === "string" && parsed.paseoProjectId !== "" ? { paseoProjectId: parsed.paseoProjectId } : {}),
      ...(Object.keys(taskWorkspaces).length > 0 ? { taskWorkspaces } : {}),
      ...(dispatchers.length > 0 ? { dispatchers } : {}),
    };
  } catch {
    return undefined; // a corrupt file is ignored, not trusted
  }
}

function registrationPath(stateDir: string, slug: string): string {
  return join(projectStateDir(stateDir, slug), "project.json");
}

/**
 * Writes/updates one project's registration — merge by field: a string sets
 * the seat id, `null` clears it (the rotate/revoke paths), `undefined`
 * leaves it alone. The root binding is always rewritten. The rotation fields
 * (v0.0.20, ADR 0013 §5) follow the same law: a value sets the state (or
 * stamps `handoffRequestedAt`), `null` clears, `undefined` preserves — so
 * `project.json` is the durable rotation-state record.
 */
export function writeProjectRegistration(
  stateDir: string,
  slug: string,
  patch: {
    root: string;
    name?: string | null;
    commonDir?: string | null;
    supervisor?: string | null;
    lead?: string | null;
    rotationState?: LeadRotationState | null;
    handoffRequestedAt?: string | null;
    workspaceId?: string | null;
    paseoProjectId?: string | null;
    taskWorkspaces?: Record<string, string | null> | null;
    dispatchers?: readonly string[] | null;
  },
): void {
  const prior = readProjectRegistration(stateDir, slug);
  const name = patch.name === null ? undefined : patch.name ?? prior?.name;
  const commonDir = patch.commonDir === null ? undefined : patch.commonDir ?? prior?.commonDir;
  const supervisor = patch.supervisor === null ? undefined : patch.supervisor ?? prior?.supervisor;
  const lead = patch.lead === null ? undefined : patch.lead ?? prior?.lead;
  const rotationState = patch.rotationState === null ? undefined : patch.rotationState ?? prior?.rotationState;
  const handoffRequestedAt = patch.handoffRequestedAt === null ? undefined : patch.handoffRequestedAt ?? prior?.handoffRequestedAt;
  const workspaceId = patch.workspaceId === null ? undefined : patch.workspaceId ?? prior?.workspaceId;
  const paseoProjectId = patch.paseoProjectId === null ? undefined : patch.paseoProjectId ?? prior?.paseoProjectId;
  let taskWorkspaces: Record<string, string> | undefined;
  if (patch.taskWorkspaces === null) {
    taskWorkspaces = undefined;
  } else if (patch.taskWorkspaces !== undefined) {
    const merged: Record<string, string> = { ...(prior?.taskWorkspaces ?? {}) };
    for (const [task, wsId] of Object.entries(patch.taskWorkspaces)) {
      if (wsId === null) {
        delete merged[task];
      } else if (typeof wsId === "string" && wsId !== "") {
        merged[task] = wsId;
      }
    }
    taskWorkspaces = Object.keys(merged).length > 0 ? merged : undefined;
  } else {
    taskWorkspaces = prior?.taskWorkspaces;
  }
  let dispatchers: string[] | undefined;
  if (patch.dispatchers === null) {
    dispatchers = undefined;
  } else if (patch.dispatchers !== undefined) {
    const merged: string[] = [];
    for (const id of [...(prior?.dispatchers ?? []), ...patch.dispatchers]) {
      if (typeof id === "string" && id.trim() !== "" && !merged.includes(id.trim())) {
        merged.push(id.trim());
      }
    }
    dispatchers = merged.length > 0 ? merged : undefined;
  } else {
    dispatchers = prior?.dispatchers;
  }
  const record: Record<string, unknown> = { root: patch.root };
  if (name !== undefined) record.name = name;
  if (commonDir !== undefined) record.commonDir = commonDir;
  if (supervisor !== undefined) record.supervisor = supervisor;
  if (lead !== undefined) record.lead = lead;
  if (rotationState !== undefined) record.rotationState = rotationState;
  if (handoffRequestedAt !== undefined) record.handoffRequestedAt = handoffRequestedAt;
  if (workspaceId !== undefined) record.workspaceId = workspaceId;
  if (paseoProjectId !== undefined) record.paseoProjectId = paseoProjectId;
  if (taskWorkspaces !== undefined && Object.keys(taskWorkspaces).length > 0) record.taskWorkspaces = taskWorkspaces;
  if (dispatchers !== undefined && dispatchers.length > 0) record.dispatchers = dispatchers;
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
  writeFileSync(registrationPath(stateDir, slug), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Resolves `cwd` to its canonical Project and ensures `<stateDir>/projects/<slug>/project.json`
 * records `root` (preserving any existing fields via `writeProjectRegistration`'s merge law).
 */
export function ensureProjectRegistered(
  stateDir: string,
  cwdOrProject: string | { root: string; slug: string; gitCommonDir?: string; name?: string },
): ProjectResolution {
  const resolved: ProjectResolution =
    typeof cwdOrProject === "string"
      ? resolveProject(cwdOrProject)
      : {
          ok: true,
          root: cwdOrProject.root,
          gitCommonDir: cwdOrProject.gitCommonDir ?? join(cwdOrProject.root, ".git"),
          slug: cwdOrProject.slug,
        };
  if (!resolved.ok) return resolved;
  const existing = readProjectRegistration(stateDir, resolved.slug);
  const name =
    (typeof cwdOrProject === "object" && typeof cwdOrProject.name === "string" && cwdOrProject.name !== ""
      ? cwdOrProject.name
      : basename(resolved.root)) || resolved.slug;
  if (
    existing === undefined ||
    existing.root !== resolved.root ||
    existing.name !== name ||
    existing.commonDir !== resolved.gitCommonDir
  ) {
    writeProjectRegistration(stateDir, resolved.slug, {
      root: resolved.root,
      name,
      commonDir: resolved.gitCommonDir,
    });
  }
  return resolved;
}

/** Every registration on disk, slug order — the discovery source of record. */
export function listProjectRegistrations(stateDir: string): ProjectRegistration[] {
  const projectsDir = join(stateDir, "projects");
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return []; // no projects dir yet — nothing seated
  }
  const out: ProjectRegistration[] = [];
  for (const slug of slugs) {
    const registration = readProjectRegistration(stateDir, slug);
    if (registration !== undefined) out.push(registration);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function isSeatAgentForDiscovery(agent: { labels?: Record<string, string>; provider?: string | null }): boolean {
  const seat = agent.labels?.seat;
  if (seat !== undefined && seat !== "") return true;
  const project = agent.labels?.project;
  if (project !== undefined && project !== "") return true;
  const provider = agent.provider;
  if (typeof provider === "string" && provider !== "") {
    const head = provider.split("/")[0];
    if (head === "factory-supervisor" || head === "factory-lead" || head === "factory-peer") return true;
  }
  return false;
}

function inferAgentSeatRole(agent: { labels?: Record<string, string>; provider?: string | null }): "supervisor" | "lead" | null {
  if (agent.labels?.seat === "supervisor" || agent.labels?.seat === "lead") {
    return agent.labels.seat;
  }
  if (typeof agent.provider === "string" && agent.provider !== "") {
    const head = agent.provider.split("/")[0];
    if (head === "factory-supervisor") return "supervisor";
    if (head === "factory-lead") return "lead";
  }
  return null;
}

/**
 * Every discovered project for the surface's Project Selector: the registry
 * files (durable, root always known, marked `missingRoot: true` if the directory
 * was deleted on disk) plus live seat agents the daemon lists (`labels: {seat,
 * project}` or Role-provider sessions `factory-supervisor` / `factory-lead` / `factory-peer`)
 * plus Paseo's `<home>/projects/projects.json`. Registry wins on conflicts.
 */
export function discoverProjects(
  stateDir: string,
  liveSeatAgents: readonly { id?: string; labels?: Record<string, string>; cwd?: string; provider?: string | null }[],
  home?: string,
): DiscoveredProject[] {
  const entries = new Map<string, DiscoveredProject>();
  const projectsPrefix = `${resolve(stateDir, "projects")}/`;
  for (const registration of listProjectRegistrations(stateDir)) {
    const missing = !existsSync(registration.root);
    entries.set(registration.slug, {
      slug: registration.slug,
      name: registration.name ?? (basename(registration.root) || registration.slug),
      root: registration.root,
      commonDir: registration.commonDir ?? join(registration.root, ".git"),
      ...(missing ? { missingRoot: true } : {}),
      supervisorId: registration.supervisor ?? null,
      leadId: registration.lead ?? null,
      activeTaskCount: 0,
    });
  }
  for (const agent of liveSeatAgents) {
    if (!isSeatAgentForDiscovery(agent)) continue;
    const seatRole = inferAgentSeatRole(agent);
    const agentId = typeof agent.id === "string" && agent.id !== "" ? agent.id : null;
    const slug = agent.labels?.project;
    if (typeof slug === "string" && slug !== "") {
      const existing = entries.get(slug);
      if (existing === undefined) {
        const root = agent.cwd ?? null;
        entries.set(slug, {
          slug,
          name: (root !== null ? basename(root) : "") || slug,
          root,
          commonDir: root !== null ? join(root, ".git") : ".git",
          supervisorId: seatRole === "supervisor" ? agentId : null,
          leadId: seatRole === "lead" ? agentId : null,
          activeTaskCount: 0,
        });
      } else if (agentId !== null) {
        if (seatRole === "supervisor" && existing.supervisorId === null) existing.supervisorId = agentId;
        if (seatRole === "lead" && existing.leadId === null) existing.leadId = agentId;
      }
      continue;
    }
    if (typeof agent.cwd === "string" && agent.cwd !== "") {
      const resolved = resolveProject(agent.cwd);
      if (resolved.ok && !resolve(resolved.root).startsWith(projectsPrefix)) {
        const existing = entries.get(resolved.slug);
        if (existing === undefined) {
          entries.set(resolved.slug, {
            slug: resolved.slug,
            name: basename(resolved.root) || resolved.slug,
            root: resolved.root,
            commonDir: resolved.gitCommonDir,
            supervisorId: seatRole === "supervisor" ? agentId : null,
            leadId: seatRole === "lead" ? agentId : null,
            activeTaskCount: 0,
          });
        } else if (agentId !== null) {
          if (seatRole === "supervisor" && existing.supervisorId === null) existing.supervisorId = agentId;
          if (seatRole === "lead" && existing.leadId === null) existing.leadId = agentId;
        }
      }
    }
  }
  if (home !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, "projects", "projects.json"), "utf8")) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { projects?: unknown }).projects)
          ? (parsed as { projects: unknown[] }).projects
          : [];
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const record = entry as { archivedAt?: unknown; rootPath?: unknown };
        if ((record.archivedAt !== null && record.archivedAt !== undefined) || typeof record.rootPath !== "string" || record.rootPath === "") {
          continue;
        }
        const resolved = resolveProject(record.rootPath);
        if (resolved.ok) {
          if (!resolve(resolved.root).startsWith(projectsPrefix) && !entries.has(resolved.slug)) {
            entries.set(resolved.slug, {
              slug: resolved.slug,
              name: basename(resolved.root) || resolved.slug,
              root: resolved.root,
              commonDir: resolved.gitCommonDir,
              supervisorId: null,
              leadId: null,
              activeTaskCount: 0,
            });
          }
        } else if (existsSync(record.rootPath)) {
          const abs = resolve(record.rootPath);
          const normRoot = realpathSafe(abs);
          if (!normRoot.startsWith(projectsPrefix) && isUnsafeBootstrapDirectory(normRoot, { stateDir, paseoHome: home }) === null) {
            const commonDir = join(normRoot, ".git");
            const hash = createHash("sha1").update(commonDir).digest("hex").slice(0, 6);
            const slug = `${basename(normRoot)}-${hash}`;
            if (!entries.has(slug)) {
              entries.set(slug, {
                slug,
                name: basename(normRoot) || slug,
                root: normRoot,
                commonDir,
                supervisorId: null,
                leadId: null,
                activeTaskCount: 0,
              });
            }
          }
        }
      }
    } catch {
      // missing or unreadable Paseo projects.json is ignored
    }
  }
  return [...entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
