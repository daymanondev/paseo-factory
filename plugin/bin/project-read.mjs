/**
 * The CLIs' local, read-only Project-registry door (factory-cli-project-onboarding
 * ticket 01; ADR 0004: plain .mjs, no src/ or plugin-server imports). It backs
 * `factory project list` and `factory doctor` — verbs that must work while no
 * plugin is running, so they read `<stateDir>/projects/<slug>/project.json`
 * directly (the lane-profile store's local-read precedent, ADR 0026 §2) and
 * never write. The registration rule is the one the rest of the CLI uses
 * (`registeredProjectSlugs` in factory.mjs): a well-formed registration is a
 * parseable `project.json` object with a non-empty string `root`.
 *
 * Exports for later tickets (dispatch guard, skill pre-flight):
 *   readProjectRegistrations(stateDir)      -> [{ slug, root }] (slug order)
 *   readProjectRegistration(stateDir, slug) -> { slug, root } | undefined
 *   resolveHomeSource(flag, env)            -> "--home" | "PASEO_HOME" | "default"
 *   workspaceRegistrationState(stateDir, dir) -> resolved/registered state for a folder
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { projectStateDir, resolveProject } from "./project.mjs";

/** Parses one project.json; undefined unless it is a well-formed registration. */
export function readProjectRegistration(stateDir, slug) {
  try {
    const registration = JSON.parse(readFileSync(join(projectStateDir(stateDir, slug), "project.json"), "utf8"));
    if (registration && typeof registration === "object" && !Array.isArray(registration) && typeof registration.root === "string" && registration.root !== "") {
      return { slug, root: registration.root };
    }
  } catch {
    // absent or corrupt — names no Project, never a guess
  }
  return undefined;
}

/** Every well-formed registration under `<stateDir>/projects/`, slug order. */
export function readProjectRegistrations(stateDir) {
  let entries;
  try {
    entries = readdirSync(join(stateDir, "projects"));
  } catch {
    return [];
  }
  const registrations = [];
  for (const entry of entries.sort()) {
    const registration = readProjectRegistration(stateDir, entry);
    if (registration !== undefined) registrations.push(registration);
  }
  return registrations;
}

/** Which rung of the home precedence won: `--home` > `$PASEO_HOME` > `~/.paseo`. */
export function resolveHomeSource(flag, env = process.env) {
  if (flag !== undefined) return "--home";
  if (typeof env.PASEO_HOME === "string" && env.PASEO_HOME.trim() !== "") return "PASEO_HOME";
  return "default";
}

/**
 * Resolves a folder to its Project (git root walk-up, via resolveProject) and
 * reports whether that Project holds a well-formed registration in `stateDir`.
 * `{ resolved: false, reason }` when git cannot answer for the folder (not a
 * repository); otherwise `{ resolved: true, root, slug, registered, registration? }`.
 */
export function workspaceRegistrationState(stateDir, dir) {
  const project = resolveProject(dir);
  if (!project.ok) return { resolved: false, reason: project.reason };
  const registration = readProjectRegistration(stateDir, project.slug);
  return {
    resolved: true,
    root: project.root,
    slug: project.slug,
    registered: registration !== undefined,
    ...(registration === undefined ? {} : { registration }),
  };
}

const PLUGIN_ID = "paseo-factory";

/**
 * The active plugin install the home records (`<home>/config.json ->
 * plugins["paseo-factory"].path`, the daemon's install record) and whether its
 * `bin/factory.mjs` door is still on disk — the stale-install detector. When
 * the recorded path is gone but Paseo's managed store (`<home>/plugins/
 * paseo-factory/<id>/<subpath>`) holds a newer sibling checkout (an update
 * rotated it), that sibling is the active install, mirroring the plugin's own
 * resolveManagedPluginDir. `{ path: null }` when the home records no directory
 * install (a headless/dev home) — not stale, just unrecorded.
 */
export function readPluginInstall(home) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))?.plugins?.[PLUGIN_ID];
  } catch {
    return { path: null, exists: false };
  }
  if (!entry || typeof entry !== "object" || entry.source !== "directory" || typeof entry.path !== "string" || entry.path === "") {
    return { path: null, exists: false };
  }
  let path = entry.path;
  if (!existsSync(join(path, "bin", "factory.mjs"))) {
    const managedRoot = join(home, "plugins", PLUGIN_ID);
    const rel = relative(managedRoot, path);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const subpath = rel.split(sep).slice(1).join(sep);
      let best;
      let bestMtime = -1;
      try {
        for (const dir of readdirSync(managedRoot, { withFileTypes: true })) {
          if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
          const candidate = subpath !== "" ? join(managedRoot, dir.name, subpath) : join(managedRoot, dir.name);
          if (!existsSync(join(candidate, "bin", "factory.mjs"))) continue;
          const mtime = statSync(candidate).mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            best = candidate;
          }
        }
      } catch {
        // no managed store — the recorded path stands (and is stale)
      }
      if (best !== undefined) path = best;
    }
  }
  return { path, exists: existsSync(join(path, "bin", "factory.mjs")) };
}

/**
 * `factory doctor`'s whole diagnosis — a pure local read, no plugin, no
 * prompts. `doorPath` is the CLI door under test (the running script, or a
 * `--door` path a skill baked in); `cmd` is the copy-pasteable `factory`
 * prefix (with `--home` when the Owner passed one). Returns the JSON shape the
 * verb prints; `ok` is false exactly when the door or the recorded install is
 * stale (the one failing diagnosis — an unregistered folder is information).
 */
export function diagnose({ home, homeSource, stateDir, workspaceDir, doorPath, cmd }) {
  const cli = { path: doorPath, exists: existsSync(doorPath) };
  const install = readPluginInstall(home);
  const state = workspaceRegistrationState(stateDir, workspaceDir);
  const workspace = state.resolved
    ? { resolved: true, dir: workspaceDir, root: state.root, slug: state.slug }
    : { resolved: false, dir: workspaceDir, reason: state.reason };
  const registered = state.resolved && state.registered;
  const stale = !cli.exists || (install.path !== null && !install.exists);
  let next;
  if (stale) {
    next = "paseo plugin update paseo-factory --yes   (then restart the chat so /factory re-reads the refreshed skill)";
  } else if (!state.resolved) {
    next = `${cmd} project register --workspace "${workspaceDir}"   (bootstraps a git repository for a greenfield folder), or ${cmd} project list to pick an existing Project`;
  } else if (!registered) {
    next = `${cmd} project register --workspace "${state.root}"   (or ${cmd} project list to pick an existing Project)`;
  } else {
    next = `${cmd} supervisor dispatch --workspace "${state.root}" --message "<directive>"`;
  }
  return { ok: !stale, home, homeSource, cli, install, cwd: workspaceDir, workspace, registered, next };
}

/** The human rendering of a `diagnose` result. */
export function formatDiagnosis(d) {
  const lines = ["factory doctor"];
  lines.push(`  cli door:    ${d.cli.path}  ${d.cli.exists ? "(exists)" : "(MISSING - stale door: this path no longer exists)"}`);
  if (d.install.path === null) lines.push("  install:     not recorded in this home's config.json (headless or dev home)");
  else lines.push(`  install:     ${d.install.path}  ${d.install.exists ? "(exists)" : "(MISSING - stale install: the plugin checkout this home records is gone)"}`);
  lines.push(`  home:        ${d.home}  (source: ${d.homeSource})`);
  if (d.workspace.resolved) {
    lines.push(`  workspace:   ${d.workspace.root}${d.workspace.dir === d.workspace.root ? "" : `  (resolved from ${d.workspace.dir})`}`);
    lines.push(`  slug:        ${d.workspace.slug}`);
  } else {
    lines.push(`  workspace:   ${d.workspace.dir}  (resolves to no Project: ${d.workspace.reason})`);
  }
  lines.push(`  registered:  ${d.registered ? `yes (in ${d.home})` : `no (not in ${d.home})`}`);
  lines.push(`  next:        ${d.next}`);
  return lines.join("\n");
}
