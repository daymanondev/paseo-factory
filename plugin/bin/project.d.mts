/**
 * The Project mirror's declaration — see project.mjs for why it exists
 * (plain .mjs, no build step, no src/ imports per ADR 0004).
 * test/factory.test.ts pins src/project.ts; the CLI round-trip in
 * test/lanes.test.ts exercises this mirror through factory.mjs.
 */

export declare function projectStateDir(stateDir: string, projectSlug: string): string;
export declare function resolveProject(
  cwd: string,
): { ok: true; root: string; gitCommonDir: string; slug: string } | { ok: false; reason: string };
