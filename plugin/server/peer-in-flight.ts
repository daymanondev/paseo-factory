/**
 * The Peer-in-flight predicates the Lead-mailbox quiet point and the surface's
 * Rotate seats refusal share (ADR 0060): one law, two callers. Pure over the
 * Ledger events, the live daemon snapshot and the queued mail, so a refusal
 * can name the Tasks and Peers that hold.
 */
import { MAX_ATTEMPTS } from "./core/events.ts";
import type { LedgerEvent } from "./core/events.ts";
import type { LeadMailItem } from "./core/mailbox.ts";
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

export function driverWaveInFlight(
  events: readonly LedgerEvent[],
  liveAgents?: readonly SurfaceAgentSnapshot[],
  projectSlug?: string,
  liveness?: "running" | "live",
): boolean {
  return driverWavesInFlight(events, liveAgents, projectSlug, liveness).length > 0;
}

/**
 * v0.2.2 (ADR 0050 §1) + v0.8.5: the Tasks a live, non-`error` Peer still
 * holds — a spawn round still open with a live bound Peer, or any live
 * non-`error` Peer bound to an unsettled dispatched Task (`idle` after the
 * Owner's Esc included). Tasks that reached a Peer-terminal outcome or carry
 * queued `from: "peer"` mail (the work is back in the Lead's court) never
 * hold. `queued` is the Project's queued mailbox items, or `undefined` when
 * the mailbox is unreadable. Empty means the Project has no live Peer work.
 */
export function projectPeersInFlight(input: {
  stateDir: string;
  slug: string;
  events: readonly LedgerEvent[];
  live: readonly SurfaceAgentSnapshot[];
  queued?: readonly LeadMailItem[];
}): InFlightRound[] {
  const { stateDir, slug, events, live, queued } = input;
  const tasks = foldTasks(events);
  let queuedPeerBlockerTasks: Set<string> | undefined;
  let queuedPeerMailTasks: Set<string> | undefined;
  if (queued !== undefined) {
    const queuedPeerMail = queued.filter((item) => item.from === "peer" && typeof item.task === "string");
    queuedPeerBlockerTasks = new Set(queuedPeerMail.filter((item) => item.kind === "needs_human" || item.kind === "peer_challenge").map((item) => item.task!));
    queuedPeerMailTasks = new Set(queuedPeerMail.map((item) => item.task!));
  }
  const settledTasks = new Set(
    tasks.filter((task) => taskHasSettledPeerOutcome(task, queuedPeerBlockerTasks)).map((task) => task.task),
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
  // dead/archived Peer releases it.
  for (const task of tasks) {
    if (settledTasks.has(task.task)) continue;
    const dispatchedAndOpen =
      (task.status === "running" || task.status === "red") && !(queuedPeerMailTasks?.has(task.task) ?? false);
    const holders = boundTaskPeers({ stateDir, slug, task: task.task, events, live }).filter(
      (peer) => peerIsRunning(peer) || (dispatchedAndOpen && peer.status !== "error"),
    );
    if (holders.length > 0) hold(task.task, holders.map((peer) => peer.id));
  }
  return [...held.entries()].map(([task, ids]) => ({ task, agentIds: [...ids] }));
}

