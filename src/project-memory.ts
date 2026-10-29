import { statSync } from "node:fs";
import { join } from "node:path";
const files = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
/** Probe the execution workspace, including Task worktrees, before suggesting reads. */
export function projectMemoryPresence(workspace?: string): string {
  if (!workspace) return "Project memory: check the Seat kickoff packet; read only files marked present and skip absent files.";
  const present = files.filter(file => {
    try { return statSync(join(workspace, file)).isFile(); } catch { return false; }
  });
  if (!present.length) return "Project memory: none present on disk (AGENTS.md, CLAUDE.md, CONTEXT.md are absent — do not call read_file on them)";
  return `Project memory: read before acting: ${present.join(", ")}; ${files.filter(file => !present.includes(file)).map(file => `${file} (absent — do not call read_file)`).join("; ")}`;
}
