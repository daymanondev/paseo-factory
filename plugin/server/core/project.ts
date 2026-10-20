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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, basename, join, resolve } from "node:path";

/** Git plumbing is a fact about the checkout, so it gets the same short leash as the workspace calls. */
const GIT_TIMEOUT_MS = 10_000;

export type ProjectResolution =
  | { ok: true; root: string; gitCommonDir: string; slug: string }
  | { ok: false; reason: string };

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
export function ensureProjectRegistered(stateDir: string, cwd: string): ProjectResolution {
  const resolved = resolveProject(cwd);
  if (!resolved.ok) return resolved;
  const existing = readProjectRegistration(stateDir, resolved.slug);
  if (existing === undefined || existing.root !== resolved.root) {
    writeProjectRegistration(stateDir, resolved.slug, { root: resolved.root });
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

/**
 * Every discovered project for the surface's Project Selector: the registry
 * files (durable, root always known) plus live seat agents the daemon lists
 * (`labels: {seat, project}`; the agent's cwd names the root). Registry wins
 * on conflicts — a seat agent's cwd is where it was created, the registry is
 * where the project was resolved.
 */
export function discoverProjects(
  stateDir: string,
  liveSeatAgents: readonly { labels: Record<string, string>; cwd: string }[],
  home?: string,
): { slug: string; root: string | null }[] {
  const roots = new Map<string, string | null>();
  for (const registration of listProjectRegistrations(stateDir)) {
    roots.set(registration.slug, registration.root);
  }
  for (const agent of liveSeatAgents) {
    const slug = agent.labels.project;
    if (slug === undefined || agent.labels.seat === undefined) continue;
    if (!roots.has(slug)) roots.set(slug, agent.cwd);
  }
  if (home !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, "projects", "projects.json"), "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry === null || typeof entry !== "object") continue;
          const record = entry as { archivedAt?: unknown; rootPath?: unknown };
          if (record.archivedAt !== null || typeof record.rootPath !== "string" || record.rootPath === "") continue;
          const resolved = resolveProject(record.rootPath);
          if (resolved.ok && !roots.has(resolved.slug)) {
            roots.set(resolved.slug, resolved.root);
          }
        }
      }
    } catch {
      // missing or unreadable Paseo projects.json is ignored
    }
  }
  return [...roots.entries()].map(([slug, root]) => ({ slug, root })).sort((a, b) => a.slug.localeCompare(b.slug));
}
