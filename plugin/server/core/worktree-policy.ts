import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeScopePath, scopeGlob } from "./scope-policy.ts";

function gitIn(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
}

/** Include patterns select whole directory prefixes or the same glob semantics used by scope fences. */
export function worktreeIncludeMatches(pattern: string, file: string): boolean {
  const clean = normalizeScopePath(pattern);
  return pattern.endsWith("/") ? file.startsWith(`${clean}/`) : scopeGlob(clean).test(file);
}

/** Hydrate only selected untracked/ignored files, and keep these runtime additions out of Git status. */
export function hydrateTaskWorktree(root: string, worktree: string, options: { copyIncludes?: boolean; inheritNodeModules?: boolean } = {}): void {
  const excluded: string[] = [];
  if (options.copyIncludes !== false) {
    let raw = "";
    try { raw = readFileSync(join(root, ".worktreeinclude"), "utf8"); } catch { /* optional include policy */ }
    const patterns = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    const candidates = new Set<string>();
    if (patterns.length > 0) {
      for (const extra of [[], ["--ignored"]]) {
        const listed = gitIn(root, ["ls-files", "-z", "--others", "--exclude-standard", ...extra]);
        if (listed.error !== undefined || listed.status !== 0) continue;
        for (const file of listed.stdout.split("\0")) if (file !== "") candidates.add(file);
      }
    }
    for (const file of candidates) {
      if (!patterns.some((pattern) => worktreeIncludeMatches(pattern, file))) continue;
      const source = join(root, file);
      const target = join(worktree, file);
      try {
        if (!statSync(source).isFile()) continue;
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
        excluded.push(file);
      } catch { /* an inaccessible optional file does not refuse allocation */ }
    }
  }
  if (options.inheritNodeModules !== false && inheritNodeModules(root, worktree)) excluded.push("node_modules");
  excludeFromWorktree(root, worktree, excluded);
}

function inheritNodeModules(root: string, worktree: string): boolean {
  const source = join(root, "node_modules");
  const target = join(worktree, "node_modules");
  try {
    if (!statSync(source).isDirectory()) return false;
    try { lstatSync(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    }
    return true;
  } catch { return false; }
}

function excludeFromWorktree(root: string, worktree: string, files: readonly string[]): void {
  if (files.length === 0) return;
  try {
    const result = gitIn(worktree, ["rev-parse", "--git-dir"]);
    if (result.error !== undefined || result.status !== 0) return;
    const excludes = join(resolve(worktree, result.stdout.trim()), "factory-excludes");
    let existing = "";
    try { existing = readFileSync(excludes, "utf8"); } catch { /* first allocation */ }
    // Anchor exact copied names and escape Git wildcard syntax; never hide unrelated paths.
    const patterns = new Set([...existing.split("\n").filter(Boolean), ...files.map((file) => `/${file.replace(/[\\*?\[\] ]/g, "\\$&")}`)]);
    writeFileSync(excludes, `${[...patterns].join("\n")}\n`);
    gitIn(root, ["config", "extensions.worktreeConfig", "true"]);
    gitIn(worktree, ["config", "--worktree", "core.excludesFile", excludes]);
  } catch { /* failure remains visible as a dirty tree at the Claim station */ }
}
