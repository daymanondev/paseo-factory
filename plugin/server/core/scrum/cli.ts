import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DOC_FILES, lintScrumDoc } from "./linter.ts";
import type { ScrumDocKind } from "./linter.ts";
import { verifyQaFiles } from "./qa-bundle.ts";
export function lintScrumDirectory(
  kind: string,
  dir: string,
): { code: number; diagnostics: unknown[] } {
  if (!Object.hasOwn(DOC_FILES, kind) || !dir)
    return {
      code: 2,
      diagnostics: [
        {
          category: "invocation",
          message: "--kind prd|ux|architecture|backlog|qa and --dir required",
        },
      ],
    };
  try {
    readdirSync(dir);
    const files: Record<string, string> = {};
    const read = (name: string) => {
      try {
        files[name] = readFileSync(join(dir, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    for (const name of [
      ...DOC_FILES[kind as ScrumDocKind],
      ...(kind === "backlog" ? ["prd.md"] : []),
    ])
      read(name);
    if (kind === "ux")
      for (const match of (files["mockups/index.html"] ?? "").matchAll(
        /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
      ))
        if (
          !match[1].includes(":") &&
          !match[1].includes("..") &&
          !match[1].startsWith("/")
        )
          read(`mockups/${match[1]}`);
    const diagnostics = lintScrumDoc(kind as ScrumDocKind, files);
    if (kind === "qa" && files["qa-report.json"] && !diagnostics.length) {
      const report = JSON.parse(files["qa-report.json"]);
      // Evidence paths are Project-relative; caller passes the initiative under cwd.
      for (const message of verifyQaFiles(process.cwd(), report))
        diagnostics.push({
          path: "qa-report.json",
          line: 1,
          category: "qa-evidence",
          message,
        });
    }
    return { code: diagnostics.length ? 1 : 0, diagnostics };
  } catch (error) {
    return {
      code: 2,
      diagnostics: [{ category: "unreadable", message: String(error) }],
    };
  }
}
