import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { capHandoffText } from "./handoff-text.ts";

/** Shared continuity document for a dead or unresponsive Supervisor, Lead or Peer. */
export function buildSubstituteHandover(input: {
  digest: string;
  notebook: string;
  git: string;
  tasks: string;
  timeline: string;
  maxBytes: number;
}): string {
  const sections = [
    ["Ledger digest", input.digest],
    ["Project notebook", input.notebook],
    ["Git state", input.git],
    ["Open Tasks", input.tasks],
    ["Recent timeline", input.timeline],
  ];
  // Reserve each section's space so a large notebook cannot erase later evidence.
  const budget = Math.max(64, Math.floor((input.maxBytes - 256) / sections.length));
  return capHandoffText("# Plugin-built handover\n\n" + sections.map(([title, body]) =>
    `## ${title}\n${capHandoffText(body || "(none available)", budget)}`,
  ).join("\n\n"), input.maxBytes);
}

export function readNotebook(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch { return "(no Project notebook)"; }
}

/** Bounded, read-only git observation at the root/worktree relevant to the seat. */
export function readHandoverGit(root: string): string {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : "(unavailable)";
  };
  return `Branch: ${git(["branch", "--show-current"])}\nHEAD: ${git(["rev-parse", "HEAD"])}\nDirty files:\n${git(["status", "--short"]) || "(clean)"}`;
}
