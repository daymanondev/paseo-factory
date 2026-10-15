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
import { realpathSync } from "node:fs";
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
