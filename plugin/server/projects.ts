/**
 * The project registry (v0.0.14, ADR 0010 §1/§5): every project the factory
 * has seated records its identity in `<stateDir>/projects/<slug>/project.json`
 * — the durable `<project-slug>` → `<project-root>` binding the surface's
 * Project Selector lists and the session-open env injection matches seat
 * agent ids against. The registry is a cache of identities the ledger and
 * the daemon already hold; a missing or corrupt file degrades to discovery
 * from live seat agents, never to a wrong guess.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "./core/project.ts";

/** One project's registry entry — the root binding plus the seat agent ids, when seats live. */
export interface ProjectRegistration {
  slug: string;
  root: string;
  supervisor?: string;
  lead?: string;
}

/** Reads `<stateDir>/projects/<slug>/project.json` — undefined when the project has no registry yet. */
export function readProjectRegistration(stateDir: string, slug: string): ProjectRegistration | undefined {
  const path = join(projectStateDir(stateDir, slug), "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectRegistration>;
    if (typeof parsed.root !== "string" || parsed.root === "") return undefined;
    return {
      slug,
      root: parsed.root,
      ...(typeof parsed.supervisor === "string" && parsed.supervisor !== "" ? { supervisor: parsed.supervisor } : {}),
      ...(typeof parsed.lead === "string" && parsed.lead !== "" ? { lead: parsed.lead } : {}),
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
 * leaves it alone. The root binding is always rewritten.
 */
export function writeProjectRegistration(stateDir: string, slug: string, patch: { root: string; supervisor?: string | null; lead?: string | null }): void {
  const prior = readProjectRegistration(stateDir, slug);
  const supervisor = patch.supervisor === null ? undefined : patch.supervisor ?? prior?.supervisor;
  const lead = patch.lead === null ? undefined : patch.lead ?? prior?.lead;
  const record: Record<string, string> = { root: patch.root };
  if (supervisor !== undefined) record.supervisor = supervisor;
  if (lead !== undefined) record.lead = lead;
  mkdirSync(projectStateDir(stateDir, slug), { recursive: true });
  writeFileSync(registrationPath(stateDir, slug), `${JSON.stringify(record, null, 2)}\n`);
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
  return [...roots.entries()].map(([slug, root]) => ({ slug, root })).sort((a, b) => a.slug.localeCompare(b.slug));
}
