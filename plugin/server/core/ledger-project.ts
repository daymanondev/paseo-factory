/**
 * Per-Project ledger resolution for the standalone CLIs (v0.0.92, ADR 0045
 * §1 completion): the `factory` CLI, the `factory run` Driver, the
 * Role-scoped MCP bridge, and the Antigravity `PreToolUse` hook all read
 * their events through this module so a registered Project's isolated
 * `<stateDir>/projects/<slug>/ledger.jsonl` answers before the archived
 * legacy root `<stateDir>/ledger.jsonl` is ever consulted. Checked
 * TypeScript, bundled into `plugin/bin/ledger-project.mjs` by the policy
 * generator — the CLIs import no plugin-server code (ADR 0004).
 *
 * The resolution order mirrors the plugin server's own
 * `resolveTargetProject` (plugin/server/projects.ts): explicit
 * `project`/`projectSlug` → workspace/cwd git-root resolution (managed Task
 * worktree paths included) → unique Task id lookup across the registered
 * per-Project ledgers → single-registered-Project fallback. The legacy root
 * ledger is the terminal fallback — a machine no per-Project ledger exists
 * on is a pre-0.0.89 machine, and there the root ledger is still the truth.
 * Read-only throughout: nothing here registers, repairs, or writes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readLedgerEvents } from "./ledger-read.ts";
import { resolveRealGitBinary } from "./worktree-policy.ts";
import type { LedgerEvent } from "./events.ts";

/** Git plumbing gets the same short leash as every other workspace call. */
const GIT_TIMEOUT_MS = 10_000;

/** The context one scoped CLI read carries — the fields the callers already hold. */
export interface ProjectLedgerContext {
  /** Explicit Project slug — the `--project <slug>` flag or the bridge's correlation binding. */
  project?: string;
  /** The same explicit slug under its other field name. */
  projectSlug?: string;
  /** A workspace or Project-root path — canonical git-root resolution, Task worktree paths included. */
  workspace?: string;
  /** The same path under its other field name (the caller's cwd). */
  cwd?: string;
  /** A bare Task id — the unique-lookup arm. */
  task?: string;
  /** Every Task of the invocation (the Driver's wave) — any uniquely-owned Task resolves. */
  tasks?: readonly string[];
}

/** One registered Project's ledger location. */
export interface ProjectLedgerStream {
  slug: string;
  path: string;
}

/** Where one scoped read lands: a Project's isolated ledger, or the legacy root. */
export type ResolvedProjectLedger =
  | { mode: "project"; slug: string; path: string; via: "explicit" | "workspace" | "task" | "single" }
  | { mode: "root"; path: string };

/** The canonical per-Project ledger location. */
export function projectLedgerPath(stateDir: string, slug: string): string {
  return join(stateDir, "projects", slug, "ledger.jsonl");
}

/**
 * The Supervisor binding's single writer for the zero-dependency CLIs and
 * self-contained MCP bridge (v0.6.1, ADR 0057 §11, spec story 18): updates
 * `<stateDir>/projects/<slug>/project.json` via read-merge-write with every
 * unrelated field preserved verbatim, landed atomically (tmp + rename) so a
 * crash mid-write can never tear `project.json`. An absent or unparseable
 * registration writes nothing. Returns true when the file changed.
 */
export function writeSupervisorBinding(stateDir: string, projectSlug: string, agentId: string): boolean {
  const projectDir = join(stateDir, "projects", projectSlug);
  const path = join(projectDir, "project.json");
  if (!existsSync(path)) return false;
  let registration: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    registration = parsed as Record<string, unknown>;
  } catch {
    return false; // a corrupt registration is never overwritten by a binding update
  }
  if (registration.supervisor === agentId) return false;
  registration.supervisor = agentId;
  mkdirSync(projectDir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registration, null, 2)}\n`);
  renameSync(tmp, path);
  return true;
}

/**
 * Every registered Project's slug, registry order — the durable
 * `<stateDir>/projects/<slug>/project.json` binding decides, never a
 * directory-name guess. A corrupt or partial registration is not a Project.
 */
export function registeredProjectSlugs(stateDir: string): string[] {
  const projectsDir = join(stateDir, "projects");
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries.sort()) {
    try {
      const registration = JSON.parse(readFileSync(join(projectsDir, entry, "project.json"), "utf8")) as { root?: unknown };
      if (registration !== null && typeof registration === "object" && typeof registration.root === "string" && registration.root !== "") slugs.push(entry);
    } catch {
      // not a registration — never a guess
    }
  }
  return slugs;
}

/** Every registered Project's ledger stream, slug order. */
export function projectLedgerStreams(stateDir: string): ProjectLedgerStream[] {
  return registeredProjectSlugs(stateDir).map((slug) => ({ slug, path: projectLedgerPath(stateDir, slug) }));
}

/** Reads one ledger file whole under the status/cost integrity policy — missing reads empty, corrupt throws. */
export function readLedgerEventsList(path: string): LedgerEvent[] {
  const read = readLedgerEvents(path);
  if ("missing" in read) return [];
  if ("failed" in read) throw new Error(`cannot read ${path}: ${read.failed instanceof Error ? read.failed.message : String(read.failed)}`);
  if ("corrupt" in read) throw new Error(`${path} is not a readable ledger: ${read.corrupt}`);
  return read.events;
}

/**
 * The canonical slug for a workspace/cwd path, when it binds to a REGISTERED
 * Project: a managed Task worktree under `<stateDir>/projects/<slug>/worktrees/<task>`
 * names its Project directly (the worktree directory may even be gone), any
 * other path resolves through git (`rev-parse --show-toplevel
 * --git-common-dir`, the common dir following a linked worktree home). An
 * unregistered or unresolvable path binds nothing — undefined, never a guess.
 */
function projectSlugForWorkspace(stateDir: string, workspace: string): string | undefined {
  const prefix = `${resolve(stateDir, "projects")}/`;
  if (workspace.startsWith(prefix)) {
    const segments = workspace.slice(prefix.length).split("/");
    const [slug, kind] = segments;
    if (slug !== undefined && slug !== "" && (kind === undefined || kind === "worktrees") && registeredProjectSlugs(stateDir).includes(slug)) {
      return slug;
    }
  }
  const gitBin = resolveRealGitBinary(stateDir);
  let stdout: string;
  try {
    stdout = execFileSync(gitBin, ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  const lines = stdout.trim().split("\n");
  const root = (lines[0] ?? "").trim();
  const commonDirRaw = (lines[1] ?? "").trim();
  if (root === "" || commonDirRaw === "") return undefined;
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(workspace, commonDirRaw);
  let gitCommonDir: string;
  try {
    gitCommonDir = realpathSync(commonDirAbs);
  } catch {
    return undefined;
  }
  const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
  const slug = `${basename(root)}-${hash}`;
  return registeredProjectSlugs(stateDir).includes(slug) ? slug : undefined;
}

/**
 * The unique registered Project whose ledger owns `task` (a `contract_set`
 * line names ownership). Zero owners or ambiguous ownership both read as
 * undefined — the caller's remaining arms decide, never a guess.
 */
export function projectSlugOwningTask(stateDir: string, task: string): string | undefined {
  const owners: string[] = [];
  for (const stream of projectLedgerStreams(stateDir)) {
    if (!existsSync(stream.path)) continue;
    if (readLedgerEventsList(stream.path).some((event) => event.event === "contract_set" && event.task === task)) owners.push(stream.slug);
  }
  return owners.length === 1 ? owners[0] : undefined;
}

/**
 * Resolves ONE scoped read's ledger: explicit slug → workspace/cwd → unique
 * Task id (any of the invocation's Tasks) → single-registered-Project → the
 * legacy root. The root arm is the terminal default — on a migrated machine
 * the root file is archived and absent, so an unresolved scoped read lands
 * on an honest empty stream rather than a wrong Project's events.
 */
export function resolveProjectLedger(stateDir: string, context: ProjectLedgerContext = {}): ResolvedProjectLedger {
  // 1. explicit slug (or path) — the --project flag / correlation binding.
  const explicit = (context.project ?? context.projectSlug ?? "").trim();
  if (explicit !== "") {
    const slug = explicit.includes("/") ? projectSlugForWorkspace(stateDir, explicit) : registeredProjectSlugs(stateDir).includes(explicit) ? explicit : undefined;
    if (slug !== undefined) return { mode: "project", slug, path: projectLedgerPath(stateDir, slug), via: "explicit" };
  }

  // 2. workspace / cwd — the canonical git-root slug, or the managed Task worktree path.
  const workspace = (context.workspace ?? context.cwd ?? "").trim();
  if (workspace !== "") {
    const slug = projectSlugForWorkspace(stateDir, workspace);
    if (slug !== undefined) return { mode: "project", slug, path: projectLedgerPath(stateDir, slug), via: "workspace" };
  }

  // 3. unique Task lookup across the registered per-Project ledgers.
  const tasks = [context.task, ...(context.tasks ?? [])].map((task) => (task ?? "").trim()).filter((task) => task !== "");
  for (const task of tasks) {
    const slug = projectSlugOwningTask(stateDir, task);
    if (slug !== undefined) return { mode: "project", slug, path: projectLedgerPath(stateDir, slug), via: "task" };
  }

  // 4. the single-registered-Project fallback.
  const registered = registeredProjectSlugs(stateDir);
  if (registered.length === 1) return { mode: "project", slug: registered[0]!, path: projectLedgerPath(stateDir, registered[0]!), via: "single" };

  // 5. the legacy root — the terminal default (on a migrated machine the
  // root file is archived and absent, so an unresolved scoped read lands on
  // an honest empty stream rather than a wrong Project's events).
  return { mode: "root", path: join(stateDir, "ledger.jsonl") };
}

/** One scoped read's outcome: the ledger it landed on, and that ledger's events. */
export function readProjectLedgerEvents(
  stateDir: string,
  context: ProjectLedgerContext = {},
): { path: string; slug?: string; events: LedgerEvent[] } {
  const resolved = resolveProjectLedger(stateDir, context);
  return {
    path: resolved.path,
    ...(resolved.mode === "project" ? { slug: resolved.slug } : {}),
    events: readLedgerEventsList(resolved.path),
  };
}
