import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { FactoryError } from "../errors.ts";
import { artifactRefIsValid, safePath } from "./types.ts";
import type { ArtifactRef } from "./types.ts";
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export function gitBytes(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function artifactAt(
  root: string,
  commit: string,
  path: string,
): ArtifactRef {
  if (!safePath(path) || !/^[a-f0-9]{40}$/.test(commit))
    throw new FactoryError("invalid-artifact-ref", path);
  return {
    path,
    commit,
    sha256: sha256(gitBytes(root, "show", `${commit}:${path}`)),
  };
}
export function verifyRefs(
  root: string,
  refs: ArtifactRef[],
  owned?: string[],
): void {
  for (const ref of refs) {
    if (
      !artifactRefIsValid(ref) ||
      (owned !== undefined && !owned.includes(ref.path))
    )
      throw new FactoryError("invalid-artifact-ref", ref.path);
    try {
      gitBytes(root, "merge-base", "--is-ancestor", ref.commit, "HEAD");
      if (
        artifactAt(root, ref.commit, ref.path).sha256 !== ref.sha256 ||
        artifactAt(
          root,
          gitBytes(root, "rev-parse", "HEAD").toString().trim(),
          ref.path,
        ).sha256 !== ref.sha256
      )
        throw new Error("artifact changed");
    } catch {
      throw new FactoryError(
        "stale-artifact-ref",
        `${ref.path} is missing, changed, or not landed`,
      );
    }
  }
}
export function designDigest(refs: ArtifactRef[]): string {
  return sha256(
    JSON.stringify(
      [...refs]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((r) => [r.path, r.commit, r.sha256]),
    ),
  );
}
/** Namespace collision is an admission error, never a license to force-add a tracker. */
export function assertInitiativeAvailable(root: string, id: string): void {
  const path = join(root, ".scratch", id);
  if (existsSync(path))
    throw new FactoryError("initiative-path-occupied", path);
  const tracked = gitBytes(root, "ls-files", "--", `.scratch/${id}`)
    .toString()
    .trim();
  if (tracked) throw new FactoryError("initiative-path-occupied", tracked);
}
export function trackOwnedArtifacts(
  root: string,
  owned: string[],
  requested: string[],
): void {
  const canonical = realpathSync(root);
  for (const path of requested) {
    if (!safePath(path) || !owned.includes(path))
      throw new FactoryError("artifact-not-owned", path);
    const full = resolve(root, path);
    if (
      lstatSync(full).isSymbolicLink() ||
      !realpathSync(full).startsWith(canonical + sep)
    )
      throw new FactoryError("artifact-path-escape", path);
  }
  if (requested.length) gitBytes(root, "add", "-f", "--", ...requested);
}
