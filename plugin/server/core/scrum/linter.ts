/** Deterministic structural checks; semantic readiness and browser QA are separate. */
import { designScreens, screenIdValid, DESIGN_STATES, browserCoverageIssues } from "./design-contract.ts";
import { OPEN_DESIGN_DIRECTIONS } from "../open-design/open-design.ts";
import { artifactMarkup, runOpenDesignLint } from "../open-design/open-design-lint.ts";
import type { Diagnostic } from "../open-design/open-design-lint.ts";
export type { Diagnostic };
import { productChromeIssues } from "./product-chrome.ts";
import { designTokens } from "./design-contract.ts";
import { validateQaReport } from "./qa-bundle.ts";
export type ScrumDocKind = "prd" | "ux" | "architecture" | "backlog" | "qa" | "ui";
export const DOC_FILES: Record<ScrumDocKind, string[]> = {
  ui: ["browser.json", "EXPERIENCE.md"],
  prd: ["prd.md"],
  ux: ["DESIGN.md", "EXPERIENCE.md", "mockups/index.html"],
  architecture: ["architecture.md"],
  backlog: ["sprint-backlog.md"],
  qa: ["qa-report.json", "qa-report.md"],
};
function prose(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n");
}
function definitions(
  text: string,
  pattern: string,
): { id: string; line: number; body: string }[] {
  const lines = prose(text).split("\n"),
    result: { id: string; line: number; body: string }[] = [];
  const regex = new RegExp(
    `^\\s*(?:#{1,6}\\s+|[-*]\\s+|\\|\\s*)?\\*{0,2}(${pattern})\\*{0,2}(?=\\s*[:—–|]|\\s+)`,
  );
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(regex);
    if (match)
      result.push({
        id: match[1],
        line: i + 1,
        body: lines.slice(i).join("\n"),
      });
  }
  const boundary =
    /^\s*(?:#{1,6}\s+|[-*]\s+|\|\s*)?\*{0,2}(?:(?:FR|NFR|UJ|AD)-[1-9]\d*|R[1-9]\d*|S-[0-9]+)\*{0,2}(?=\s*[:—–|]|\s+)/;
  for (const definition of result) {
    let end = definition.line;
    while (end < lines.length && !boundary.test(lines[end])) end++;
    definition.body = lines.slice(definition.line - 1, end).join("\n");
  }
  return result;
}
export function lintScrumDoc(
  kind: ScrumDocKind,
  files: Record<string, string>,
  options: { requireOpenDesignOnly?: boolean } = {},
): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const add = (path: string, line: number, category: string, message: string) =>
    issues.push({ path, line, category, message });
  for (const path of DOC_FILES[kind])
    if (typeof files[path] !== "string" || !files[path].trim())
      add(path, 1, "missing", "required artifact is absent or empty");
  const defs = (path: string, pattern: string) => {
    const found = definitions(files[path] ?? "", pattern),
      seen = new Set<string>();
    for (const d of found) {
      if (seen.has(d.id))
        add(path, d.line, "duplicate", `duplicate definition ${d.id}`);
      seen.add(d.id);
    }
    return found;
  };
  if (kind === "prd") {
    const text = prose(files["prd.md"] ?? "");
    for (const section of ["Outcome", "Out of Scope"])
      if (!new RegExp(`^#{1,6}\\s+${section}\\s*$`, "im").test(text))
        add("prd.md", 1, "section", `missing ${section}`);
    for (const category of ["FR", "NFR", "UJ"]) {
      if (
        !defs("prd.md", `${category}-[1-9]\\d*`).length &&
        !new RegExp(`${category}[^\\n]*N/A\\s*[:—-]\\s*\\S.{4,}`, "i").test(
          text,
        )
      )
        add("prd.md", 1, "requirement", `define ${category} or justify N/A`);
    }
  }
  if (kind === "architecture") {
    const text = prose(files["architecture.md"] ?? "");
    if (
      !/^#{1,6}\s+Stack\b/im.test(text) ||
      !/(?:package\.json|lock(?:file)?|\.lock|runtime evidence|go\.mod|Cargo\.toml|pyproject\.toml)/i.test(
        text,
      )
    )
      add(
        "architecture.md",
        1,
        "stack",
        "Stack needs manifest/lockfile/runtime evidence",
      );
    const found = defs("architecture.md", "AD-[1-9]\\d*");
    if (!found.length)
      add(
        "architecture.md",
        1,
        "architecture",
        "at least one stable AD rule required",
      );
    for (const d of found)
      for (const field of ["Binds", "Prevents", "Rule"])
        if (!new RegExp(`\\b${field}\\*{0,2}\\s*:\\s*\\S`, "i").test(d.body))
          add(
            "architecture.md",
            d.line,
            "invariant",
            `${d.id} missing ${field}`,
          );
  }
  const dualSurface = !!files['mockups/screens.html'];
  const openDesign = options.requireOpenDesignOnly || dualSurface;
  if ((kind === 'ux' || kind === 'ui') && options.requireOpenDesignOnly !== false) issues.push(...runOpenDesignLint(files));
  if (kind === "ux") {
    const design = prose(files["DESIGN.md"] ?? ""),
      experience = prose(files["EXPERIENCE.md"] ?? ""),
      html = files["mockups/index.html"] ?? "";
    const routing = html + '\n' + Object.entries(files).filter(([p]) => p.startsWith('mockups/') && p.endsWith('.js')).map(([,s]) => s).join('\n');
    const markup = artifactMarkup(html) + Object.entries(files).filter(([p]) => p.startsWith('mockups/') && p.endsWith('.js')).map(([,s]) => artifactMarkup(s, true)).join('\n');
    const tokens = designTokens(design);
    for (const [label, values] of Object.entries(tokens).filter(([key]) => ['colors', 'typography', 'spacing', 'components'].includes(key))) {
      const legacyColor = label === 'colors' ? design.match(/\bcolor\s*[:|—-]\s*([^\n]+)/i)?.[1] : undefined;
      if ((!Array.isArray(values) || !values.length) && !(legacyColor && !/^(?:none|TODO|TBD|placeholder)\b/i.test(legacyColor))) add('DESIGN.md', 1, 'design-token', `define non-placeholder ${label} tokens`);
    }
    const screens = designScreens(experience, files['mockups/manifest.json']);
    if (!screens.length) add('EXPERIENCE.md', 1, 'screen', 'declare at least one ## Screen: kebab-case-id');
    issues.push(...productChromeIssues(openDesign ? markup : html, design, screens));
    const seen = new Set<string>();
    for (const screen of screens) {
      if (!screenIdValid(screen.id) || seen.has(screen.id)) add('EXPERIENCE.md', screen.line, 'screen', `invalid or duplicate screen ${screen.id}`);
      seen.add(screen.id);
      for (const state of dualSurface ? [] : DESIGN_STATES) {
        if (!new RegExp(`\\b${state}\\b`, 'i').test(screen.body)) add('EXPERIENCE.md', screen.line, 'state-cell', `${screen.id}/${state} needs a documented obligation`);
      }
      if (!routing.includes(screen.id)) add('mockups/index.html', 1, 'screen', `mockup does not cover ${screen.id}`);
    }
    if (!/URLSearchParams/.test(routing) || !/(?:dataset\.screen|data-screen)/.test(routing) || !/(?:dataset\.state|data-state)/.test(routing) || !/scrum:set-state/.test(routing) || !/addEventListener\s*\(\s*['"]message['"]/.test(routing))
      add('mockups/index.html', 1, 'routing', 'read screen/state query parameters, reflect root data attributes and handle scrum:set-state messages');
    if (
      !/<html\b/i.test(html) ||
      !/<\/html>/i.test(html) ||
      !/<title>[^<]+<\/title>/i.test(html) ||
      !/<(?:button|select|input)\b/i.test(markup)
    )
      add(
        "mockups/index.html",
        1,
        "html",
        "complete HTML document and keyboard-accessible product controls required",
      );
    if (
      /(?:src|href)\s*=\s*["'](?:https?:|\/\/)|@import|url\(\s*["']?https?:|fetch\s*\(|XMLHttpRequest|WebSocket/i.test(
        html,
      )
    )
      add(
        "mockups/index.html",
        1,
        "offline",
        "mockup must use declared offline assets",
      );

  }
  if ((kind === 'ux' || kind === 'ui') && openDesign) {
    for (const path of ['mockups/index.html', 'mockups/screens.html', 'mockups/design-manifest.json', ...(kind === 'ux' ? ['mockups/browser.json'] : [])]) if (!files[path]?.trim()) add(path, 1, 'missing', 'Open Design deliverable required');
    try {
      const manifest = JSON.parse(files['mockups/design-manifest.json'] ?? 'null');
      if (!manifest || !(manifest.directionId || manifest.designSystemId) || !manifest.tokens || !Object.keys(manifest.tokens).length || !Array.isArray(manifest.journeyGroups) || !manifest.journeyGroups.length || !Array.isArray(manifest.screens) || !manifest.screens.length || !Array.isArray(manifest.componentPatterns) || !manifest.componentPatterns.length)
        add('mockups/design-manifest.json', 1, 'design-manifest', 'Declare directionId/designSystemId, tokens, journeyGroups, screens and componentPatterns');
      else {
        if (!manifest.designSystemId && !OPEN_DESIGN_DIRECTIONS.some(d => d.id === manifest.directionId)) add('mockups/design-manifest.json', 1, 'design-manifest', 'Choose a curated direction or a bound Brand Design System');
        const declared = designScreens(files['EXPERIENCE.md'] ?? '');
        for (const screen of declared) if (!manifest.screens.some((s: {id?: string; surface?: string}) => s.id === screen.id && s.surface === screen.surface)) add('mockups/design-manifest.json', 1, 'design-manifest', `Missing Core Screen / surface ${screen.id}`);
        if (!manifest.journeyGroups.some((g: {title?: string}) => /System.*Edge States/i.test(g.title ?? ''))) add('mockups/design-manifest.json', 1, 'design-manifest', 'Declare a System & Edge States journey group');
      }
    } catch { add('mockups/design-manifest.json', 1, 'json', 'invalid design manifest JSON'); }
    for (const screen of designScreens(files['EXPERIENCE.md'] ?? '')) {
      if (!/(?:^|\n)\s*(?:[-*]\s*)?\*{0,2}Surface\*{0,2}\s*:/i.test(screen.body)) add('EXPERIENCE.md', screen.line, 'surface', `${screen.id} needs an explicit Surface declaration`);
    }
    if (kind === 'ux' && files['mockups/browser.json']) {
      try { for (const message of browserCoverageIssues(JSON.parse(files['mockups/browser.json']), designScreens(files['EXPERIENCE.md'] ?? ''), true, { requireOpenDesignOnly: true, sharedEdgeStates: dualSurface, requireBoard: true })) add('mockups/browser.json', 1, 'browser-evidence', message); }
      catch { add('mockups/browser.json', 1, 'json', 'invalid browser JSON'); }
    }
  }
  if (kind === "backlog") {
    const text = prose(files["sprint-backlog.md"] ?? ""),
      requirements = defs("sprint-backlog.md", "R[1-9]\\d*"),
      stories = defs("sprint-backlog.md", "S-[0-9]+"),
      ids = new Set(requirements.map((r) => r.id));
    if (!requirements.length || !stories.length)
      add(
        "sprint-backlog.md",
        1,
        "traceability",
        "R definitions and story definitions required",
      );
    const covered = new Set<string>();
    for (const story of stories) {
      const covers =
        story.body.match(/Covers\s*:\s*([^\n]+)/i)?.[1]?.match(/\bR\d+\b/g) ??
        [];
      if (!covers.length || !/(?:Tests|Evidence)\s*:\s*\S/i.test(story.body))
        add(
          "sprint-backlog.md",
          story.line,
          "coverage",
          `${story.id} needs Covers and test/evidence mapping`,
        );
      for (const id of covers) {
        if (!ids.has(id))
          add(
            "sprint-backlog.md",
            story.line,
            "dangling",
            `undefined Covers ${id}`,
          );
        covered.add(id);
      }
    }
    for (const r of requirements)
      if (
        !covered.has(r.id) &&
        !/(?:blocked|deferred)\s*:\s*\S.{4,}/i.test(r.body)
      )
        add("sprint-backlog.md", r.line, "coverage", `${r.id} is unassigned`);
    const sources = definitions(
      files["prd.md"] ?? "",
      "(?:FR|NFR|UJ)-[1-9]\\d*",
    );
    const sourceIds = new Set(sources.map((d) => d.id));
    for (const match of text.matchAll(/\b(?:FR|NFR|UJ)-[1-9]\d*\b/g))
      if (!sourceIds.has(match[0]))
        add("sprint-backlog.md", 1, "dangling", `undefined source ${match[0]}`);
    const mappedSources = new Set(
      requirements.flatMap((r) =>
        [...r.body.matchAll(/^\s*Sources?\s*:\s*([^\n]+)/gim)].flatMap(
          (m) => m[1].match(/\b(?:FR|NFR|UJ)-[1-9]\d*\b/g) ?? [],
        ),
      ),
    );
    for (const d of sources)
      if (!mappedSources.has(d.id))
        add("sprint-backlog.md", 1, "coverage", `${d.id} has no R mapping`);
  }
  if (kind === 'ui' && files['browser.json']) {
    try {
      const required = designScreens(files['EXPERIENCE.md'] ?? '', files['mockups/manifest.json']);
      if (!required.length) add('EXPERIENCE.md', 1, 'screen', 'UI verification requires declared screens');
      for (const message of browserCoverageIssues(JSON.parse(files['browser.json']), required, true, { requireOpenDesignOnly: openDesign, sharedEdgeStates: dualSurface })) add('browser.json', 1, 'browser-evidence', message);
    } catch { add('browser.json', 1, 'json', 'invalid browser JSON'); }
  }
  if (kind === "qa" && files["qa-report.json"]) {
    try {
      for (const message of validateQaReport(
        JSON.parse(files["qa-report.json"]),
      ))
        add("qa-report.json", 1, "qa-evidence", message);
    } catch {
      add("qa-report.json", 1, "json", "invalid JSON");
    }
  }
  for (const path of DOC_FILES[kind].filter((p) => p.endsWith(".md"))) {
    const lines = prose(files[path] ?? "").split("\n");
    for (let i = 0; i < lines.length; i++)
      if (/\b(?:TODO|TBD)\b/.test(lines[i]))
        add(path, i + 1, "placeholder", "unresolved literal placeholder");
  }
  return issues;
}
