import { z } from "zod";

export const LaneRefSchema = z.object({ provider: z.string(), model: z.string(), thinking: z.string().optional() });
export type LaneRef = z.infer<typeof LaneRefSchema>;
export const HandoffProgressSchema = z.object({
  seat: z.string(),
  reason: z.enum(["context-mark", "provider-change", "owner"]),
  state: z.enum(["scheduled", "handing-over", "creating-successor", "done", "substitute", "failed"]),
  fromLane: LaneRefSchema,
  toLane: LaneRefSchema,
  waitingPeers: z.number().int().optional(),
  handover: z.enum(["extracted", "substitute"]).optional(),
  failure: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type HandoffProgress = z.infer<typeof HandoffProgressSchema>;
export type HandoffAction = "start" | "replaceNow" | "cancel" | "retry" | "handover";
export interface HandoffRequest {
  slug: string;
  seat?: string;
  action: HandoffAction;
  reason?: HandoffProgress["reason"];
  fromLane?: string;
  toLane?: string;
  /** Optional Owner choice for a Peer successor. */
  lane?: string;
}
export type HandoffReply =
  | { ok: true; progress: HandoffProgress | null; text?: string; source?: "extracted" | "substitute" }
  | { ok: false; code: string; error: string };
