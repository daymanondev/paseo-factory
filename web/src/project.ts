/**
 * The console's Project write transports (ADR 0051) — the scoped Project's
 * two destructive Owner acts (T-10e) plus the Owner's Add-Project wizard
 * acts (T-12), all through the sidecar's RPC door. `factory.project.reset`
 * (the Project's ledger events, task state, and task files purged; seats
 * archived unless `keepSeats` rides true) and `factory.project.delete` (the
 * Project and ALL its Factory state removed, then the console returns to
 * the unscoped Overview) carry EXACTLY the scoped `projectRoot` the Project
 * panel folds — never a slug door, never a `seat` — because the door itself
 * refuses anything else (`forbidden_operation` as data before any handler
 * runs). The wizard's two acts ride their own doors: `factory.project.add`
 * registers a folder by path (the door refuses the empty add) and
 * `factory.project.pick.folder` opens the daemon host's native picker — a
 * cancelled pick answers `{ok, cancelled, path: null}` and a picked one
 * registers the folder itself, answering with the full add payload. Each
 * reply IS the shared output union (`plugin/shared/rpc.ts`) consumed
 * verbatim per the envelope law: a refusal is data the screen renders,
 * never a throw, and the success arm carries the handler's own `summary`
 * plus the counts/facts the banners fold.
 */
import type { ProjectView } from "../../plugin/shared/view.ts";
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

// ---- the Add-Project wizard transports (T-12) ---------------------------------------------------------

/**
 * The add input — the wizard's typed or picked path alone; the door refuses
 * the empty add (`forbidden_operation` as data), and the dialog never builds it.
 */
export interface ProjectAddInput {
  path: string;
}

/**
 * The add success arm — the handler's own facts: the resolved root, the
 * derived slug, the bootstrapped flag (true when Factory ran `git init` +
 * the initial empty commit, ADR 0024), the summary sentence, and the
 * scoped view the console can land on.
 */
export interface ProjectAddSuccess {
  path: string;
  projectRoot: string;
  slug: string;
  project: ProjectView;
  bootstrapped: boolean;
  summary: string;
}

export type ProjectAddReply = ({ ok: true } & ProjectAddSuccess) | RpcFailure;

/** The pick's cancelled arm — the native dialog closed without a choice; nothing was added. */
export interface ProjectPickCancelled {
  cancelled: true;
  path: null;
}

/**
 * The pick reply — the handler's own three arms consumed verbatim: the
 * cancelled arm (nothing happened), the picked arm (the folder registered
 * itself, carrying the full add payload), or a Failure as data.
 */
export type ProjectPickReply = ({ ok: true } & ProjectPickCancelled) | ({ ok: true; cancelled: false } & ProjectAddSuccess) | RpcFailure;

export function projectAddViaSidecar(input: ProjectAddInput, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProjectAddReply> {
  return invokeRpc<ProjectAddSuccess>("factory.project.add", input, fetchImpl);
}

export function projectPickFolderViaSidecar(prompt?: string, fetchImpl: FetchLike = (request, init) => fetch(request, init)): Promise<ProjectPickReply> {
  return invokeRpc<ProjectPickCancelled | ({ cancelled: false } & ProjectAddSuccess)>(
    "factory.project.pick.folder",
    prompt === undefined ? {} : { prompt },
    fetchImpl,
  );
}
