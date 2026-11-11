import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DOC_FILES, lintScrumDoc } from "./linter.ts";
import type { ScrumDocKind } from "./linter.ts";
import { verifyBrowserFiles } from "./browser-files.ts";
import { designScreens } from "./design-contract.ts";
import { readMockupFiles } from "../open-design/open-design-cli.ts";
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
          message: "--kind prd|ux|architecture|backlog|qa|ui and --dir required",
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
    if (kind === 'ui') {
      try { files['EXPERIENCE.md'] = readFileSync(join(dir, '../../EXPERIENCE.md'), 'utf8'); } catch { /* Missing artifact is a diagnostic. */ }
    }
    if (kind === 'ux' || kind === 'ui') {
      const mockups = kind === 'ux' ? join(dir, 'mockups') : join(dir, '../../mockups');
      Object.assign(files, readMockupFiles(mockups));
    }
    const diagnostics = lintScrumDoc(kind as ScrumDocKind, files, { requireOpenDesignOnly: kind === 'ux' || kind === 'ui' });
    if (kind === 'ux' && files['mockups/browser.json'] && !diagnostics.length) {
      for (const message of verifyBrowserFiles(process.cwd(), JSON.parse(files['mockups/browser.json']), designScreens(files['EXPERIENCE.md']), { requireOpenDesignOnly: true, sharedEdgeStates: true, requireBoard: true })) diagnostics.push({ path: 'mockups/browser.json', line: 1, category: 'browser-evidence', message });
    }
    if (kind === 'ui' && files['browser.json'] && !diagnostics.length) {
      for (const message of verifyBrowserFiles(process.cwd(), JSON.parse(files['browser.json']), designScreens(files['EXPERIENCE.md']), { requireOpenDesignOnly: true, sharedEdgeStates: true })) diagnostics.push({ path: 'browser.json', line: 1, category: 'browser-evidence', message });
    }
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
