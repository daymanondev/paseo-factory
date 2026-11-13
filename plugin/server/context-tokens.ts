import { readFileSync } from "node:fs";
import type { SurfaceAgentSnapshot } from "./surface-rpc.ts";
import { readNativeContextWindowTokens, type UsagePaths } from "./core/usage-extractor.ts";

// ---- the deterministic context sensor (ADR 0013 §5, "Reading Lead Context Tokens") ----------

/** What the sensor read, and where it read it from — nulls mean "unknown", never a guess. */
export interface LeadContextTokens {
  usedTokens: number | null;
  maxTokens: number | null;
  source: "daemon" | "session-file" | "native-store";
}

/**
 * Reads one seat's context-window usage deterministically — 0 LLM tokens, no
 * 4th agent role. Primary: the live daemon snapshot's `lastUsage`
 * (`contextWindowUsedTokens` / `contextWindowMaxTokens`, the SDK's
 * `AgentUsage` fields). Fallback (after a daemon restart, when `lastUsage` is
 * gone): the Pi session `.jsonl` at `persistence.nativeHandle` — the LAST
 * assistant message carrying `usage` answers, computed as
 * `totalTokens || (input + output + cacheRead + cacheWrite)`.
 */
export function readLeadContextTokens(lead: SurfaceAgentSnapshot, usagePaths?: UsagePaths): LeadContextTokens {
  const used = finiteNumber(lead.lastUsage?.contextWindowUsedTokens);
  const reportedMax = finiteNumber(lead.lastUsage?.contextWindowMaxTokens);
  const maxTokens = reportedMax !== null && reportedMax > 0 ? reportedMax : null;
  if (used !== null && used > 0) {
    return { usedTokens: used, maxTokens, source: "daemon" };
  }
  const native = lead.persistence?.nativeHandle;
  if (typeof native === "string" && native !== "") {
    const fromFile = readLastAssistantUsageTokens(native);
    if (fromFile !== null) return { usedTokens: fromFile, maxTokens, source: "session-file" };
  }
  // The multi-provider fallback (v0.0.87, ADR 0043 §3): every harness's own
  // native store answers when the daemon gauge is gone — codex's rollout
  // tail, antigravity's steps table, and so on, not just Pi's `.jsonl`.
  const fromStore = readNativeContextWindowTokens(lead, usagePaths);
  if (fromStore !== null) return { usedTokens: fromStore, maxTokens, source: "native-store" };
  // Some restarted harnesses expose an empty daemon gauge while their
  // native session already contains context. Prefer that reading; retain a
  // reported zero only when no native reading exists.
  return { usedTokens: used === 0 ? 0 : null, maxTokens, source: "daemon" };
}

/**
 * The `.jsonl` fallback's one read: walk the session file's lines backwards,
 * find the last assistant message carrying a `usage` record (skipping later
 * lines without one), and fold it — `totalTokens` wins when present, else the
 * component sum. Tolerant of the wrapper shapes Pi writes (`message` nested
 * or flat) and of camelCase / snake_case usage keys; anything unreadable is
 * a null, never a guess.
 */
function readLastAssistantUsageTokens(sessionPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a damaged line is skipped, never trusted
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { message?: { role?: unknown; usage?: unknown }; role?: unknown; usage?: unknown };
    const message = record.message !== undefined && typeof record.message === "object" ? record.message : record;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const usage = (message as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const total = finiteNumber(numberAt(usage, ["totalTokens", "total_tokens"]));
    if (total !== null) return total;
    const components = [
      numberAt(usage, ["input", "inputTokens", "input_tokens"]),
      numberAt(usage, ["output", "outputTokens", "output_tokens"]),
      numberAt(usage, ["cacheRead", "cacheReadTokens", "cache_read_input_tokens"]),
      numberAt(usage, ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"]),
    ];
    if (components.every((value) => value === null)) continue;
    return components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  return null;
}

/** The first numeric value among the record's named keys — null when none is a finite number. */
function numberAt(record: object, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber((record as Record<string, unknown>)[key]);
    if (value !== null) return value;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

