/** Deterministic structural checks; semantic readiness and browser QA are separate. */
import { validateQaReport } from "./qa-bundle.ts";
export type ScrumDocKind = "prd" | "ux" | "architecture" | "backlog" | "qa";
export interface Diagnostic {
  path: string;
  line: number;
  category: string;
  message: string;
}
export const DOC_FILES: Record<ScrumDocKind, string[]> = {
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
  if (kind === "ux") {
    const design = prose(files["DESIGN.md"] ?? ""),
      experience = prose(files["EXPERIENCE.md"] ?? ""),
      html = files["mockups/index.html"] ?? "";
    for (const token of ["color", "typography", "spacing", "component"])
      if (!new RegExp(token, "i").test(design))
        add("DESIGN.md", 1, "design-token", `missing ${token}`);
    const states = [
      "empty",
      "loading",
      "populated",
      "error",
      "offline",
      "permission-denied",
    ];
    const rows = experience.split("\n").filter((l) => /^\s*\|/.test(l));
    const header = rows.find((r) => states.every((s) => r.includes(s)));
    if (!header)
      add(
        "EXPERIENCE.md",
        1,
        "state-matrix",
        "screen × state matrix with all six states required",
      );
    else {
      const cells = header
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
      const data = rows
        .slice(rows.indexOf(header) + 1)
        .filter((r) => !/^\s*\|[\s:|—-]+\|\s*$/.test(r));
      if (!data.length)
        add(
          "EXPERIENCE.md",
          1,
          "state-matrix",
          "at least one justified screen required",
        );
      for (const row of data) {
        const values = row
          .split("|")
          .slice(1, -1)
          .map((s) => s.trim());
        for (const state of states) {
          const v = values[cells.indexOf(state)];
          if (
            !v ||
            /^N\/A$/i.test(v) ||
            (/N\/A/i.test(v) && !/N\/A\s*[:—-]\s*\S.{3,}/i.test(v))
          )
            add(
              "EXPERIENCE.md",
              experience.split("\n").indexOf(row) + 1,
              "state-cell",
              `${state} needs obligation or justified N/A`,
            );
        }
      }
    }
    if (
      !/<html\b/i.test(html) ||
      !/<\/html>/i.test(html) ||
      !/<title>[^<]+<\/title>/i.test(html) ||
      !/<(?:button|select|input)\b/i.test(html)
    )
      add(
        "mockups/index.html",
        1,
        "html",
        "complete HTML document and keyboard state controls required",
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
    for (const match of html.matchAll(
      /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    )) {
      const asset = match[1];
      if (asset.startsWith("#") || asset.startsWith("data:")) continue;
      if (
        asset.startsWith("/") ||
        asset.includes("..") ||
        files[`mockups/${asset}`] === undefined
      )
        add(
          "mockups/index.html",
          1,
          "asset",
          `missing or unsafe declared asset ${asset}`,
        );
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
