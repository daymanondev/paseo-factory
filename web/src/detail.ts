/**
 * The Task Detail read journey (T-03) — `factory.task.detail` through the
 * sidecar's RPC door. The reply IS the shared output union
 * (`plugin/shared/rpc.ts` — `{ ok: true, detail: TaskDetailView } |
 * Failure`), consumed verbatim per the envelope law: a refusal is data the
 * screen shows, never a throw. Read-only — the detail carries the tailed
 * report and gate-log content the handler already folds (`readTailed`), so
 * no second read door exists to add.
 */
import type { TaskDetailView } from "../../plugin/shared/view.ts";
import { invokeRpc, type FetchLike } from "./rpc.ts";

export type TaskDetailReply = { ok: true; detail: TaskDetailView } | { ok: false; code: string; error: string };

export function taskDetailViaSidecar(
  input: { task: string },
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<TaskDetailReply> {
  return invokeRpc<{ detail: TaskDetailView }>("factory.task.detail", input, fetchImpl);
}
