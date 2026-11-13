/** Recently observed live seat models, persisted across plugin restarts. */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { atomicJson } from "./core/json-store.ts";
import { LaneRefSchema, type LaneRef } from "../shared/handoff.ts";
import { z } from "zod";
const Entry = z.object({ lane: LaneRefSchema, usedAt: z.string() });
const History = z.record(z.string(), z.array(Entry));
export function recentSeatModels(stateDir: string, role: string, observed?: { lane: LaneRef; usedAt: string }): LaneRef[] {
  const path = join(stateDir, "seat-model-history.json");
  let history: z.infer<typeof History> = {};
  try { history = History.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { /* No valid history yet. */ }
  const entries = history[role] ?? [];
  if (observed && observed.lane.provider && observed.lane.model) {
    const prior = entries.find(e => e.lane.provider === observed.lane.provider && e.lane.model === observed.lane.model);
    if (!prior || observed.usedAt > prior.usedAt) {
      history[role] = [...entries.filter(e => e !== prior), observed].sort((a, b) => b.usedAt.localeCompare(a.usedAt)).slice(0, 12);
      atomicJson(path, history);
    }
  }
  return (history[role] ?? []).map(e => e.lane);
}
