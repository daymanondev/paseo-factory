import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { TaskView } from "../shared/view.ts";
import { capHandoffText } from "./handoff-text.ts";

const EXTRACTION_PROMPT_ECHO_RE = /^(?:# (?:Peer|Lead) handoff extraction\b|Supervisor handoff:)/i;

/**
 * Extracts only human-readable `user_message` and `assistant_message` text
 * from heterogeneous timeline entries, stripping tool blobs and echoed
 * plugin handoff extraction prompts.
 */
export function extractCleanTimelineText(
  entries: readonly unknown[],
  options?: { maxEntries?: number },
): string {
  const messages: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate =
      "item" in entry && entry.item !== null && typeof entry.item === "object"
        ? entry.item
        : entry;
    const type = (candidate as { type?: unknown }).type;
    const text = (candidate as { text?: unknown }).text;
    if ((type !== "user_message" && type !== "assistant_message") || typeof text !== "string") {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed === "" || EXTRACTION_PROMPT_ECHO_RE.test(trimmed)) continue;
    const collapsed = trimmed.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    const speaker = type === "user_message" ? "User" : "Assistant";
    messages.push(`${speaker}: ${collapsed}`);
  }
  const maxEntries = options?.maxEntries;
  const bounded =
    maxEntries !== undefined
      ? maxEntries <= 0
        ? []
        : messages.slice(-maxEntries)
      : messages;
  return bounded.join("\n\n");
}

/** Shared continuity document for a dead or unresponsive Supervisor, Lead or Peer. */
export function buildSubstituteHandover(input: {
  digest: string;
  notebook?: string;
  git: string;
  tasks: string;
  timeline: string;
  maxBytes: number;
}): string {
  const sections: [string, string][] = [
    ["Ledger digest", input.digest],
    ...(input.notebook === undefined ? [] : [["Project notebook", input.notebook] as [string, string]]),
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

/** Open continuity work excludes both terminal Task outcomes. */
export function renderOpenTaskEvidence(tasks: readonly TaskView[]): string {
  return tasks.filter(task => task.status !== "accepted" && task.status !== "closed")
    .map(task => `${task.task}: ${task.status}; Attempts: ${task.attempts.length}`).join("\n");
}
