/** Durable per-seat handoff progress, shared by all three seat runtimes. */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "./core/json-store.ts";
import { projectStateDir } from "./core/project.ts";
import { parseLane } from "./core/lanes.ts";
import { HandoffProgressSchema } from "../shared/handoff.ts";
import type { HandoffProgress, LaneRef } from "../shared/handoff.ts";

export const HANDOFF_DONE_WINDOW_MS = 20_000;

export function laneRef(value: string): LaneRef {
  const lane = parseLane(value);
  return { provider: lane?.provider ?? value, model: lane?.model ?? "", ...(lane?.thinking ? { thinking: lane.thinking } : {}) };
}

export function laneValue(lane: LaneRef): string {
  return `${lane.provider}/${lane.model}${lane.thinking ? `:${lane.thinking}` : ""}`;
}

const pathOf = (stateDir: string, slug: string, seat: string) =>
  join(projectStateDir(stateDir, slug), `handoff-${seat.replace(/[^a-zA-Z0-9-]/g, "-")}.json`);

/** Expiring the display record never removes the separate handover document. */
export function readHandoffProgress(stateDir: string, slug: string, seat: string): HandoffProgress | null {
  try {
    const parsed = HandoffProgressSchema.safeParse(JSON.parse(readFileSync(pathOf(stateDir, slug, seat), "utf8")));
    if (!parsed.success) return null;
    if (parsed.data.state === "done" && Date.now() - Date.parse(parsed.data.updatedAt) > HANDOFF_DONE_WINDOW_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeHandoffProgress(stateDir: string, slug: string, progress: HandoffProgress | null, seat = progress?.seat ?? "lead"): void {
  const path = pathOf(stateDir, slug, seat);
  if (progress === null) rmSync(path, { force: true });
  else atomicJson(path, progress);
}
