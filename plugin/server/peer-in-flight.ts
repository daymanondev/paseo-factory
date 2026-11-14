/**
 * The Peer-in-flight predicates the Lead-mailbox quiet point and the surface's
 * Rotate seats refusal share (ADR 0060): one module, two callers. The module
 * computes its own inputs from the Project's slug and root (the Ledger stream
 * and the queued mail), so both callers read the same facts, and a refusal can
 * name the Tasks and Peers that hold. The two callers differ only in the
 * settle law they ask for: the quiet point lets a Peer's verdict or queued
 * blocker return the Task to the Lead; Rotate holds on any live Peer until
 * the Task is accepted or closed.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_ATTEMPTS } from "./core/events.ts";
import type { LedgerEvent } from "./core/events.ts";
import type { Factory } from "./core/factory.ts";
import { readLeadMailbox } from "./core/mailbox.ts";
import type { LeadMailItem } from "./core/mailbox.ts";
import { projectStateDir } from "./core/project.ts";
import { readHandoffProgress } from "./handoff-progress.ts";
import type { FactoryRegistry } from "./projects.ts";
import type { TaskView } from "../shared/view.ts";
import { foldTasks } from "./view.ts";
import { boundTaskPeers, peerIsRunning } from "./task-peers.ts";
import type { SurfaceAgentSnapshot } from "./surface-rpc.ts";

/** One Task held by a live Peer: the Task id and the live agents that hold it. */
export interface InFlightRound {
  task: string;
  agentIds: string[];
}

/**
 * Ledger-first quiet-point check for `rotation_pending` (v0.0.99, ADR 0031
 * §3): once a Task's folded Ledger status in the current Contract epoch has
 * reached a Peer-terminal state (`ready-to-accept` / GREEN, `needs-human`,
 * `red` at `MAX_ATTEMPTS`, or a queued `from: "peer"` blocker in
 * `mailbox.jsonl` — a `kind: "peer_challenge"` challenge awaiting the Lead's
 * ruling or a `kind: "needs_human"` ceiling stall), the Task is in Lead's
 * court and no longer counts as having Peer work in flight — even while the
 * Peer's `agent_claim` or `agent_escalate_blocker` tool call is still
 * returning inside an active turn (`peer.status === "running"`).
 */
export function taskHasSettledPeerOutcome(task: TaskView, queuedPeerBlockerTasks?: ReadonlySet<string>): boolean {
  return task.accepted ||
    task.status === "accepted" ||
    task.status === "closed" ||
    task.status === "ready-to-accept" ||
    task.status === "needs-human" ||
    (task.status === "red" && task.attempts.length >= MAX_ATTEMPTS) ||
    (queuedPeerBlockerTasks?.has(task.task) ?? false);
}

/**
 * The driver-held signal, derived from the ledger alone (spec §Implementation
 * Decisions 4, last bullet): a synchronous CLI Driver wave is in flight while
 * any task's latest spawn round is still open — `spawn_dispatched` with
 * neither a terminal verdict (`gate_finished`) nor a `needs_human` close
 * after it. The wave's last terminal outcome clears the predicate, and that
 * outcome's own peer hook pumps the held batch.
 *
 * v0.0.92 (spec §Implementation Decision 4): the live-agents liveness check
 * runs for EVERY open round — a legacy `spawn_dispatched` with no `worktree`
 * field is checked by `labels.task` and the spawned agent id, never skipped.
 * A `Peer` that has terminated, errored, or been archived (the cascade kill
 * during `Lead handoff`) removes its round immediately, so a dead `Peer` can
 * never deadlock `drainLeadMailbox` from delivering the successor Lead's
 * Turn-1 kickoff. The `labels.task` arm stays Project-scoped: two Projects
 * may share a Task id, and a neighbor's live `Peer` is not this Project's
 * wave. `agent` is absent on today's `spawn_dispatched` lines (recorded
 * before any agent exists) — the id arm is the defensive read for any future
 * writer that stamps it, with the CLI Driver's own `"driver"` marker treated
 * as absent.
 *
 * v0.2.2 (ADR 0050 §1, the durable in-flight arm): `liveness: "live"` keeps
 * an open round while its bound `Peer` is merely live and not `error` —
 * `idle`/`closed` included, because `idle`-because-paused and
 * `idle`-between-turns are indistinguishable at the only layer that survives
 * restarts (the ledger plus the live daemon snapshot). Only the quiet-point
 * check (`projectPeerInFlight`) passes `"live"`; the default `"running"`
 * arm (running/initializing only) keeps governing `notifyPeer`'s pump gate
 * and `projectHasPeerWork`; a `Peer` that has already queued its verdict
 * must never hold the Lead's mail delivery.
 */
export function driverWavesInFlight(
  events: readonly LedgerEvent[],
  liveAgents?: readonly SurfaceAgentSnapshot[],
  projectSlug?: string,
  liveness?: "running" | "live",
): InFlightRound[] {
  const openRounds = new Map<string, Extract<LedgerEvent, { event: "spawn_dispatched" }>>();
  const holderIds = new Map<string, string[]>();
  for (const evt of events) {
    if (!("task" in evt) || typeof evt.task !== "string") continue;
    if (evt.event === "spawn_dispatched") openRounds.set(evt.task, evt);
    else if (evt.event === "contract_set" || evt.event === "gate_finished" || evt.event === "needs_human") {
      openRounds.delete(evt.task);
    }
  }
  if (openRounds.size > 0 && liveAgents !== undefined) {
    for (const [task, spawnEvt] of [...openRounds.entries()]) {
      const wt = typeof spawnEvt.worktree === "string" && spawnEvt.worktree !== "" ? spawnEvt.worktree : undefined;
      const stampedAgent = (spawnEvt as { agent?: unknown }).agent;
      const spawnedAgentId =
        typeof stampedAgent === "string" && stampedAgent !== "" && stampedAgent !== "driver" ? stampedAgent : undefined;
      const peerIsLively = (agent: SurfaceAgentSnapshot): boolean =>
        liveness === "live" ? agent.status !== "error" : agent.status === "running" || agent.status === "initializing";
      const holders = liveAgents.filter(
        (agent) =>
          agent.archivedAt === null &&
          peerIsLively(agent) &&
          ((wt !== undefined && typeof agent.cwd === "string" && (agent.cwd === wt || agent.cwd.startsWith(`${wt}/`))) ||
            (agent.labels?.task === task &&
              (projectSlug === undefined || agent.labels?.project === undefined || agent.labels?.project === projectSlug)) ||
            (spawnedAgentId !== undefined && agent.id === spawnedAgentId)),
      );
      if (holders.length === 0) openRounds.delete(task);
      else holderIds.set(task, holders.map((agent) => agent.id));
    }
  }
  return [...openRounds.keys()].map((task) => ({ task, agentIds: holderIds.get(task) ?? [] }));
}

/**
 * Where a Project's Ledger stream comes from: the wired (root) Factory and,
 * in production, the Per-Project Factory registry. A slug the registry cannot
 * open falls back to the wired Factory — unless the caller asks `strict`, in
 * which case the error surfaces so a safety refusal can fail closed.
 */
export interface ProjectLedgerSource {
  factory: Factory;
  registry?: FactoryRegistry;
}

export function projectFactoryOf(source: ProjectLedgerSource, slug: string, strict = false): Factory {
  if (source.registry === undefined) return source.factory;
  try {
    return source.registry.factoryForProject(slug);
  } catch (err) {
    if (strict) throw err;
    return source.factory;
  }
}

/** The Factory owning `task` for this Project — the Project's own first, the wired root-bridge second. */
export function taskFactoryOf(source: ProjectLedgerSource, slug: string, task: string | undefined, strict = false): Factory {
  const project = projectFactoryOf(source, slug, strict);
  if (project === source.factory || task === undefined || task === "") return project;
  if (project.contractFor(task) !== undefined) return project;
  return source.factory.contractFor(task) !== undefined ? source.factory : project;
}

/** The Project's Ledger stream: its OWN Factory's events plus any task the wired Factory still owns (the legacy root bridge). */
export function projectStreamOf(source: ProjectLedgerSource, slug: string, strict = false): readonly LedgerEvent[] {
  const project = projectFactoryOf(source, slug, strict);
  if (project === source.factory) return source.factory.ledger.events;
  const wiredOnly = source.factory.ledger.events.filter((evt) => {
    if (!("task" in evt) || typeof evt.task !== "string") return true; // machine-level facts stay visible
    return project.contractFor(evt.task) === undefined;
  });
  return [...project.ledger.events, ...wiredOnly];
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The Project's task-scoped events: tasks whose Contract workspace sits inside `root` (symlinks resolved) or the Project's worktrees dir. */
export function projectEventsOf(source: ProjectLedgerSource, stateDir: string, slug: string, root: string, strict = false): readonly LedgerEvent[] {
  const normRoot = realpathSafe(resolve(root));
  const worktreesDir = join(projectStateDir(stateDir, slug), "worktrees");
  return projectStreamOf(source, slug, strict).filter((evt) => {
    if (!("task" in evt) || typeof evt.task !== "string") return false;
    const contract = taskFactoryOf(source, slug, evt.task, strict).contractFor(evt.task);
    if (contract === undefined) return false;
    const ws = contract.workspace;
    const normWs = realpathSafe(resolve(ws));
    return ws === root || ws.startsWith(`${root}/`) || normWs === normRoot || normWs.startsWith(`${normRoot}/`) ||
      ws === worktreesDir || ws.startsWith(`${worktreesDir}/`);
  });
}

/** The Project's queued mailbox items, or `undefined` when the mailbox is unreadable. */
export function readQueuedMail(stateDir: string, slug: string): readonly LeadMailItem[] | undefined {
  try {
    return readLeadMailbox(join(projectStateDir(stateDir, slug), "mailbox.jsonl")).queued;
  } catch {
    return undefined;
  }
}

/**
 * v0.2.2 (ADR 0050 §1) + v0.8.5: the Tasks a live, non-`error` Peer still
 * holds — a spawn round still open with a live bound Peer, or any live
 * non-`error` Peer bound to an unsettled dispatched Task (`idle` after the
 * Owner's Esc included). Empty means the Project has no live Peer work.
 *
 * `law` picks what settles a Task:
 * - `"quiet-point"` (the Lead's quiet point): a Peer-terminal outcome or any
 *   queued `from: "peer"` mail returns the Task to the Lead, so it never holds.
 * - `"rotate"` (ADR 0060): only an accepted or closed Task settles. A Peer's
 *   queued challenge or blocker is exactly the work Rotate would delete, so
 *   queued mail never releases a live Peer.
 *
 * `strict` makes an unreadable Ledger throw instead of reading as empty — a
 * refusal built on this result must fail closed.
 */
export function projectPeersInFlight(input: {
  stateDir: string;
  slug: string;
  root: string;
  source: ProjectLedgerSource;
  live: readonly SurfaceAgentSnapshot[];
  law: "quiet-point" | "rotate";
  strict?: boolean;
}): InFlightRound[] {
  const { stateDir, slug, root, source, live, law } = input;
  const events = projectEventsOf(source, stateDir, slug, root, input.strict === true);
  const tasks = foldTasks(events);
  const rotate = law === "rotate";
  const queued = rotate ? undefined : readQueuedMail(stateDir, slug);
  let queuedPeerBlockerTasks: Set<string> | undefined;
  let queuedPeerMailTasks: Set<string> | undefined;
  if (queued !== undefined) {
    const queuedPeerMail = queued.filter((item) => item.from === "peer" && typeof item.task === "string");
    queuedPeerBlockerTasks = new Set(queuedPeerMail.filter((item) => item.kind === "needs_human" || item.kind === "peer_challenge").map((item) => item.task!));
    queuedPeerMailTasks = new Set(queuedPeerMail.map((item) => item.task!));
  }
  const settledTasks = new Set(
    tasks
      .filter((task) => rotate ? task.accepted || task.status === "accepted" || task.status === "closed" : taskHasSettledPeerOutcome(task, queuedPeerBlockerTasks))
      .map((task) => task.task),
  );
  const activeWaveEvents = settledTasks.size > 0 || (queuedPeerMailTasks?.size ?? 0) > 0
    ? events.filter(
        (evt) =>
          !("task" in evt) ||
          typeof evt.task !== "string" ||
          (!settledTasks.has(evt.task) && !(queuedPeerMailTasks?.has(evt.task) ?? false)),
      )
    : events;
  const held = new Map<string, Set<string>>();
  const hold = (task: string, agentIds: readonly string[]): void => {
    const ids = held.get(task) ?? new Set<string>();
    for (const id of agentIds) ids.add(id);
    held.set(task, ids);
  };
  for (const round of driverWavesInFlight(activeWaveEvents, live, slug, "live")) hold(round.task, round.agentIds);
  // A dispatched, unsettled Task (`running`, or `red` below the ceiling) whose
  // bound Peer is live and not `error` holds, whatever the Peer's status.
  // Only an outcome (verdict, needs-human, close, any queued Peer mail) or a
  // dead/archived Peer releases it. Under the Rotate law every unsettled Task
  // qualifies.
  for (const task of tasks) {
    if (settledTasks.has(task.task)) continue;
    const dispatchedAndOpen =
      rotate || ((task.status === "running" || task.status === "red") && !(queuedPeerMailTasks?.has(task.task) ?? false));
    const holders = boundTaskPeers({ stateDir, slug, task: task.task, events, live }).filter(
      (peer) => peerIsRunning(peer) || (dispatchedAndOpen && peer.status !== "error"),
    );
    if (holders.length > 0) hold(task.task, holders.map((peer) => peer.id));
  }
  return [...held.entries()].map(([task, ids]) => ({ task, agentIds: [...ids] }));
}

/**
 * The Tasks of the Project whose Peer handoff (the context-ceiling
 * replacement) is still in progress. Rotate refuses while one runs: it never
 * cancels or resets a Peer's state, and a replacement mid-flight is a live
 * Peer for every purpose that matters here.
 */
export function peerHandoffsInProgress(input: {
  stateDir: string;
  slug: string;
  root: string;
  source: ProjectLedgerSource;
  strict?: boolean;
}): string[] {
  const { stateDir, slug } = input;
  const tasks = new Set<string>();
  for (const evt of projectEventsOf(input.source, stateDir, slug, input.root, input.strict === true)) {
    if ("task" in evt && typeof evt.task === "string") tasks.add(evt.task);
  }
  return [...tasks].filter((task) => {
    const state = readHandoffProgress(stateDir, slug, `peer:${task}`)?.state;
    return state !== undefined && state !== "done" && state !== "failed";
  });
}
