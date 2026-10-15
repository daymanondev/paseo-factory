/**
 * The Factory surface's RPC contracts (v0.0.13, ADR 0009 §2/§4) — the one
 * vocabulary both halves import. Every method name is `factory.*` (the
 * daemon validates `[a-z][a-z0-9._-]*` and uniqueness); every output is a
 * discriminated union on `ok` so a refusal is data, never an exception
 * (PigMonitor's `Failure` pattern). The handlers run inside the plugin
 * server process that owns the single Factory instance — the in-process
 * single-writer amendment to ADR 0004: Owner acts from the UI invoke
 * `factory.accept(...)`/`factory.retro()` directly, never through the
 * spool.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FactoryViewSchema, LaneNameSchema, TaskDetailViewSchema } from "./view.ts";

/** Every handler's refusal shape: a stable machine code plus the human sentence. */
export const Failure = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

export const snapshot = defineRpc({
  name: "factory.snapshot",
  input: z.object({}),
  output: z.union([z.object({ ok: z.literal(true), view: FactoryViewSchema }), Failure]),
});

// Method names must match /^[a-z][a-z0-9._-]*$/ (the daemon validates and
// rejects uppercase), so the camelCase ticket spelling `factory.taskDetail`
// ships as `factory.task.detail`.
export const taskDetail = defineRpc({
  name: "factory.task.detail",
  input: z.object({ task: z.string().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), detail: TaskDetailViewSchema }), Failure]),
});

export const accept = defineRpc({
  name: "factory.accept",
  input: z.object({ task: z.string().min(1), attempt: z.number().int().min(1) }),
  output: z.union([z.object({ ok: z.literal(true), seq: z.number().int(), summary: z.string() }), Failure]),
});

export const retro = defineRpc({
  name: "factory.retro",
  input: z.object({}),
  output: z.union([
    z.object({
      ok: z.literal(true),
      outcome: z.string(),
      proposalCount: z.number().int().nullable(),
      proposalsPath: z.string().nullable(),
      error: z.string().nullable(),
    }),
    Failure,
  ]),
});

export const lanesSet = defineRpc({
  name: "factory.lanes.set",
  input: z.object({ lane: LaneNameSchema, value: z.string().min(1) }),
  output: z.union([
    z.object({
      ok: z.literal(true),
      lanes: z.object({
        supervisor: z.string(),
        worker: z.string(),
        watch: z.string(),
        retro: z.string(),
        freshEyes: z.string(),
      }),
      /** What the live Supervisor model sync did: applied / skipped (no live supervisor) / failed (reason). */
      modelSync: z.string(),
    }),
    Failure,
  ]),
});

export const supervisorEnsure = defineRpc({
  name: "factory.supervisor.ensure",
  input: z.object({ message: z.string().optional() }),
  output: z.union([
    z.object({ ok: z.literal(true), agentId: z.string(), created: z.boolean(), supervisorDir: z.string().nullable() }),
    Failure,
  ]),
});

export const supervisorRevoke = defineRpc({
  name: "factory.supervisor.revoke",
  input: z.object({}),
  output: z.union([z.object({ ok: z.literal(true), agentId: z.string() }), Failure]),
});
