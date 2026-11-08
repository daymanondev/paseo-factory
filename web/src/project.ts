/**
 * The console's Settings Danger Zone transports (ADR 0051, T-10e) — the
 * scoped Project's two destructive Owner acts through the sidecar's RPC
 * door: `factory.project.reset` (the Project's ledger events, task state,
 * and task files purged; seats archived unless `keepSeats` rides true) and
 * `factory.project.delete` (the Project and ALL its Factory state removed,
 * then the console returns to the unscoped Overview). Both inputs carry
 * EXACTLY the scoped `projectRoot` the Project panel folds — never a slug
 * door, never a `seat` — because the door itself refuses anything else
 * (`forbidden_operation` as data before any handler runs). Each reply IS
 * the shared output union (`plugin/shared/rpc.ts`) consumed verbatim per
 * the envelope law: a refusal is data the screen renders, never a throw,
 * and the success arm carries the handler's own `summary` plus the
 * purged/removed/archived counts the banner folds.
 */
import { invokeRpc, type FetchLike, type RpcFailure } from "./rpc.ts";

/**
 * The reset input — the scoped root plus the "Keep live seats" checkbox,
 * spelled EXPLICITLY (true or false): the checkbox's promise is the wire's
 * truth, exactly the vault confirm law.
 */
export interface ProjectResetInput {
  projectRoot: string;
  keepSeats?: boolean;
}

/** The delete input — the scoped root alone; the door refuses every other field the schema allows. */
export interface ProjectDeleteInput {
  projectRoot: string;
}

/** The shared success arm both Danger Zone writes answer — the handler's own summary and counts. */
export interface ProjectDangerSuccess {
  project: string;
  projectRoot: string;
  purgedEvents: number;
  tasks: string[];
  removedFiles: number;
  archivedSeats: string[];
  archivedAgents: string[];
  summary: string;
}

export type ProjectDangerReply = ({ ok: true } & ProjectDangerSuccess) | RpcFailure;

export function projectResetViaSidecar(input: ProjectResetInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProjectDangerReply> {
  return invokeRpc<ProjectDangerSuccess>("factory.project.reset", input, fetchImpl);
}

export function projectDeleteViaSidecar(input: ProjectDeleteInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProjectDangerReply> {
  return invokeRpc<ProjectDangerSuccess>("factory.project.delete", input, fetchImpl);
}
