/**
 * The CLIs' Project-identity mirror (v0.0.14, ADR 0010 §1/§5 / ADR 0004:
 * plain .mjs, importing no src/ or plugin-server code), kept behaviorally
 * identical to src/project.ts by test/lanes.test.ts's CLI round-trip and
 * test/factory.test.ts's core assertions. `factory lanes --project <dir>`
 * resolves the directory to its canonical `<project-slug>` before touching
 * `<stateDir>/projects/<slug>/lanes.json`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

export function projectStateDir(stateDir, projectSlug) {
  return join(stateDir, "projects", projectSlug);
}

/**
 * Mirrors resolveProject in src/project.ts: `git rev-parse --show-toplevel
 * --git-common-dir` → { root, gitCommonDir, slug } with
 * `slug = <basename(root)>-<sha1(realpath(gitCommonDir)).slice(0,6)>`. The
 * common dir may print relative to the invocation cwd (`../.git` from a
 * subdirectory), so it resolves against cwd before its realpath. A directory
 * git cannot answer for is a named refusal, never a guess.
 */
export function resolveProject(cwd) {
  let stdout;
  try {
    stdout = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr;
    const first = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "";
    return { ok: false, reason: first !== "" ? first : err instanceof Error ? err.message : String(err) };
  }
  const lines = stdout.trim().split("\n");
  const root = (lines[0] ?? "").trim();
  const commonDirRaw = (lines[1] ?? "").trim();
  if (root === "" || commonDirRaw === "") {
    return { ok: false, reason: `git did not answer --show-toplevel --git-common-dir for ${cwd}` };
  }
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw);
  let gitCommonDir;
  try {
    gitCommonDir = realpathSync(commonDirAbs);
  } catch {
    return { ok: false, reason: `the git common dir ${commonDirAbs} of ${root} does not exist on disk` };
  }
  const hash = createHash("sha1").update(gitCommonDir).digest("hex").slice(0, 6);
  return { ok: true, root, gitCommonDir, slug: `${basename(root)}-${hash}` };
}
