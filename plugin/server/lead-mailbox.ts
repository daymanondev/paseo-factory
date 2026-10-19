/**
 * The Lead mailbox runtime (v0.0.20, ADR 0013 Decisions 3–4): the plugin-side
 * single writer around one `<projectStateDir>/mailbox.jsonl` per Project. The
 * pure fold and the append helpers live in `./core/mailbox.ts` (ticket 05's
 * core); this module owns everything around them:
 *
 *   - the serialized per-Project async lane `projectLane(slug)` — one promise
 *     chain per slug, so every read-then-append against a Project's mailbox
 *     and every seat act on that Project run in submission order (the
 *     single-writer law ADR 0004 names);
 *   - `enqueueLeadMail` — append `mail_queued` through the core, on the lane;
 *   - `drainLeadMailbox` — when the Project's Lead is idle (no pending
 *     permissions), `rotationState === "normal"`, nothing in flight, and mail
 *     is queued: batch ALL queued items into one formatted prompt,
 *     `agents.ref(leadAgentId).send(...)`, then append `mail_delivered`;
 *   - `pumpProjectLead` — run the lane; nothing is settled here yet (ticket 07
 *     grows the turn-boundary ack/requeue state machine into this same
 *     function);
 *   - `dispatchLead` — the spool's `lead_dispatch` handler: resolve the target
 *     Project (`workspace` via resolveProject, `project` slug via the
 *     registry), auto-ensure the Lead seat (the `leadEnsure` path — the
 *     spec's `ensureProjectSeat("lead")`), append `mail_queued`
 *     (`from` = the request's `from ?? "owner"`), pump, and reply with the
 *     dispatch facts;
 *   - `notifyPeer` — the spool's peer hook: a Task's terminal Verdict or
 *     needs-human recording lands as `from: "peer"` mail on the owning
 *     Project's lane, held while a synchronous CLI Driver wave is in flight
 *     (derived from the ledger alone) and flushed as one consolidated
 *     delivery when the wave's last outcome closes it;
 *   - `startupRecovery` — run the core's recovery helper with
 *     `reason: "daemon-restart"` for every registered Project, so an un-acked
 *     delivery from a crashed lifetime returns to `queued` (zero mail lost).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import type { LedgerEvent } from "./core/events.ts";
import { listProjectRegistrations, projectStateDir, readProjectRegistration, resolveProject } from "./core/project.ts";
import type { ProjectRegistration } from "./core/project.ts";
import { deliverLeadMail as appendMailDelivered, enqueueLeadMail as appendMailQueued, readLeadMailbox, recoverLeadMailbox } from "./core/mailbox.ts";
import type { LeadMailFrom, LeadMailItem, LeadMailKind } from "./core/mailbox.ts";
import type { SpoolLeadDispatchRequest, SpoolReply } from "./spool.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";

/** The ensure result the surface handlers' `leadEnsure` answers — the runtime's seat door. */
export type EnsureLeadResult =
  | { ok: true; agentId: string; created: boolean; projectRoot: string; slug: string }
  | { ok: false; code: string; error: string };

export interface LeadMailRuntimeDeps {
  factory: Factory;
  stateDir: string;
  /** The daemon to deliver through — the live PaseoApi or the tests' fake. */
  daemon: SurfaceDaemonApi | (() => SurfaceDaemonApi);
  /**
   * Auto-ensure a Project's Lead seat (ADR 0013 Decision 4's
   * `ensureProjectSeat("lead")`): the surface handlers' `leadEnsure` is the
   * implementation — find-or-create the standing `seat=lead` agent at the
   * Project's root under its lane.
   */
  ensureLead: (input: { projectRoot: string }) => Promise<EnsureLeadResult>;
  onLog?: (message: string) => void;
}

/** One runtime's public face — see the module doc for each member's law. */
export interface LeadMailRuntime {
  dispatchLead(request: SpoolLeadDispatchRequest): Promise<SpoolReply>;
  notifyPeer(input: { task: string; kind: "verdict" | "needs_human"; text: string }): Promise<void>;
  enqueueLeadMail(slug: string, mail: { from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string }): Promise<{ mailId: string }>;
  pumpProjectLead(slug: string): Promise<void>;
  startupRecovery(): void;
}

export function createLeadMailRuntime(deps: LeadMailRuntimeDeps): LeadMailRuntime {
  // One promise chain per slug: every lane job starts only after the prior
  // job for the SAME Project settles (either way — a failed job never poisons
  // the chain), so read-then-append against one mailbox is atomic in practice.
  const lanes = new Map<string, Promise<unknown>>();
  const log = deps.onLog ?? (() => {});
  const resolveDaemon = (): SurfaceDaemonApi => (typeof deps.daemon === "function" ? deps.daemon() : deps.daemon);
  const mailboxPath = (slug: string): string => join(projectStateDir(deps.stateDir, slug), "mailbox.jsonl");

  const projectLane = <T>(slug: string, run: () => Promise<T>): Promise<T> => {
    const prior = lanes.get(slug) ?? Promise.resolve();
    const job = prior.then(run, run);
    lanes.set(
      slug,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    return job;
  };

  /**
   * `rotationState` as it sits in `project.json` — read defensively as
   * `string | undefined`: ticket 07 owns the field's persistence, so today
   * nothing writes it and every read folds to "normal".
   */
  const readRotationState = (slug: string): string | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(join(projectStateDir(deps.stateDir, slug), "project.json"), "utf8")) as { rotationState?: unknown };
      return typeof parsed.rotationState === "string" ? parsed.rotationState : undefined;
    } catch {
      return undefined; // no registration yet, or an unreadable one — the default stands
    }
  };

  const enqueueLeadMail = (slug: string, mail: { from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string }): Promise<{ mailId: string }> =>
    projectLane(slug, async () => {
      const queued = appendMailQueued(mailboxPath(slug), mail);
      return { mailId: queued.mailId };
    });

  /** The live non-archived Lead agent of one Project — the seatOf law, on the runtime's daemon slice. */
  const liveLeadAgent = async (daemon: SurfaceDaemonApi, slug: string): Promise<SurfaceAgentSnapshot | undefined> => {
    const page = await daemon.agents.list({ filter: { labels: { seat: "lead", project: slug }, includeArchived: false } });
    for (const entry of page.entries) {
      if (entry.agent.archivedAt === null) return entry.agent;
    }
    return undefined;
  };

  /**
   * The drain (ADR 0013 Decision 3's delivery rule): deliver the queued batch
   * only when the Lead is idle with no pending permissions, the mailbox is
   * unlocked (`rotationState === "normal"`), nothing is in flight, and mail
   * is actually waiting — otherwise the mail simply stays `queued` in the
   * file; holding is the safe state, losing is the bug. Sends first, appends
   * `mail_delivered` after: a failed send leaves the batch queued, never a
   * phantom delivery.
   */
  const drainLeadMailbox = async (slug: string): Promise<void> => {
    const path = mailboxPath(slug);
    const state = readLeadMailbox(path);
    if (state.inFlight !== null || state.queued.length === 0) return; // a live delivery awaits its turn-end settle (ticket 07) — or nothing waits
    if ((readRotationState(slug) ?? "normal") !== "normal") return; // rotation_pending / handing_over hold the mailbox (ticket 07's machine)
    const daemon = resolveDaemon();
    let lead: SurfaceAgentSnapshot | undefined;
    try {
      lead = await liveLeadAgent(daemon, slug);
    } catch (err) {
      log(`lead-mailbox: cannot read the daemon's agents for ${slug} — holding ${state.queued.length} item(s) queued (${messageOf(err)})`);
      return;
    }
    if (lead === undefined) return; // no live Lead — the next dispatch ensures one and pumps again
    if (lead.status !== "idle" || lead.requiresAttention) return; // a running or asking Lead is never interrupted (§User Story 12)
    await daemon.agents.ref(lead.id).send(renderMailPrompt(state.queued));
    appendMailDelivered(path, { mailIds: state.queued.map((item) => item.mailId), toAgentId: lead.id });
    log(`lead-mailbox: delivered ${state.queued.length} item(s) to the lead of ${slug} (${lead.id})`);
  };

  /** Runs the lane — the one door delivery goes through. Settles nothing here yet (ticket 07). */
  const pumpProjectLead = async (slug: string): Promise<void> => {
    await projectLane(slug, async () => {
      try {
        await drainLeadMailbox(slug);
      } catch (err) {
        // A pump failure is a delivery failure, never a mail failure — the
        // batch stays queued and the next pump retries it.
        log(`lead-mailbox: pump of ${slug} failed — the mail stays queued (${messageOf(err)})`);
      }
    });
  };

  /** The spool's `lead_dispatch` handler (ADR 0013 Decision 4, bullet 3). */
  const dispatchLead = async (request: SpoolLeadDispatchRequest): Promise<SpoolReply> => {
    // The target Project: a workspace directory resolves through git; a slug
    // resolves through the registry. Neither is a guess — each refusal names itself.
    let root: string;
    let slug: string;
    if (request.workspace !== undefined) {
      const resolved = resolveProject(request.workspace);
      if (!resolved.ok) {
        return { id: request.id, ok: false, code: "unknown-project", message: `workspace ${request.workspace} does not resolve to a git repository — ${resolved.reason}` };
      }
      root = resolved.root;
      slug = resolved.slug;
    } else if (request.project !== undefined) {
      const registration: ProjectRegistration | undefined = readProjectRegistration(deps.stateDir, request.project);
      if (registration === undefined) {
        return { id: request.id, ok: false, code: "unknown-project", message: `no project registered under slug ${request.project} — pass --workspace <dir>, or seat the project first` };
      }
      root = registration.root;
      slug = registration.slug;
    } else {
      return { id: request.id, ok: false, code: "unknown-project", message: "lead dispatch needs a target — pass --project <slug> or --workspace <dir>" };
    }
    // The auto-ensure: the Project's Lead seat exists before any mail lands.
    const ensured = await deps.ensureLead({ projectRoot: root });
    if (!ensured.ok) return { id: request.id, ok: false, code: ensured.code, message: ensured.error };
    // The directive lands as one queued mail, then the lane pumps it.
    const { mailId } = await enqueueLeadMail(slug, { from: request.from ?? "owner", kind: "directive", text: request.message });
    await pumpProjectLead(slug);
    const rotationState = readRotationState(slug) ?? "normal";
    return {
      id: request.id,
      ok: true,
      summary: `dispatched to the lead of ${slug} — agent=${ensured.agentId} mail=${mailId} rotation=${rotationState}`,
      project: slug,
      leadAgentId: ensured.agentId,
      mailId,
      rotationState,
    };
  };

  /**
   * The spool's peer hook: a Task's terminal outcome lands as `from: "peer"`
   * mail on the owning Project's lane — appended durably BEFORE any delivery
   * decision, so no regime (driver-held or not) can lose it. The pump is
   * suppressed while a synchronous CLI Driver wave is in flight; the wave's
   * last terminal outcome clears the predicate and its own hook pumps the
   * whole held batch as one consolidated delivery. Never rejects.
   */
  const notifyPeer = async (input: { task: string; kind: "verdict" | "needs_human"; text: string }): Promise<void> => {
    try {
      const workspace = contractWorkspaceOf(deps.factory.ledger.events, input.task);
      if (workspace === undefined) return; // no contract on record — no owning Project to notify
      const resolved = resolveProject(workspace);
      if (!resolved.ok) return;
      await enqueueLeadMail(resolved.slug, { from: "peer", kind: input.kind, task: input.task, text: input.text });
      if (driverWaveInFlight(deps.factory.ledger.events)) return; // held in mailbox.jsonl — the wave's last outcome pumps it
      await pumpProjectLead(resolved.slug);
    } catch (err) {
      log(`lead-mailbox: peer notification for ${input.task} failed — the outcome stays in the ledger (${messageOf(err)})`);
    }
  };

  /**
   * Startup recovery (ADR 0013 Decision 3's restart rule): every registered
   * Project's mailbox gets its un-acked delivery requeued with reason
   * `"daemon-restart"`. Idempotent by the core's own law — a settled mailbox
   * appends nothing.
   */
  const startupRecovery = (): void => {
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      try {
        const settled = recoverLeadMailbox(mailboxPath(registration.slug), "daemon-restart");
        for (const event of settled) {
          log(`lead-mailbox: recovered ${event.mailIds.length} item(s) of ${registration.slug} — requeued (daemon-restart)`);
        }
      } catch (err) {
        log(`lead-mailbox: recovery of ${registration.slug} failed — ${messageOf(err)}`);
      }
    }
  };

  return { dispatchLead, notifyPeer, enqueueLeadMail, pumpProjectLead, startupRecovery };
}

/** The last workspace a task's contract named — the owning-Project resolution, straight from the ledger. */
function contractWorkspaceOf(events: readonly LedgerEvent[], task: string): string | undefined {
  let workspace: string | undefined;
  for (const evt of events) {
    if (evt.event === "contract_set" && evt.task === task) workspace = evt.workspace;
  }
  return workspace;
}

/**
 * The driver-held signal, derived from the ledger alone (spec §Implementation
 * Decisions 4, last bullet): a synchronous CLI Driver wave is in flight while
 * any task's latest spawn round is still open — `spawn_dispatched` with
 * neither a terminal verdict (`gate_finished`) nor a `needs_human` close
 * after it. The wave's last terminal outcome clears the predicate, and that
 * outcome's own peer hook pumps the held batch.
 */
function driverWaveInFlight(events: readonly LedgerEvent[]): boolean {
  const openRounds = new Map<string, number>();
  for (const evt of events) {
    if (evt.event === "spawn_dispatched") openRounds.set(evt.task, evt.seq);
  }
  if (openRounds.size === 0) return false;
  for (const evt of events) {
    if (!("task" in evt) || typeof evt.task !== "string") continue;
    const spawnSeq = openRounds.get(evt.task);
    if (spawnSeq === undefined || evt.seq <= spawnSeq) continue;
    if (evt.event === "gate_finished" || evt.event === "needs_human") openRounds.delete(evt.task);
  }
  return openRounds.size > 0;
}

/** One queued batch as the single prompt the Lead receives — every waiting item, in enqueue order. */
function renderMailPrompt(items: readonly LeadMailItem[]): string {
  const lines: string[] = [`# Lead mailbox — ${items.length} item${items.length === 1 ? "" : "s"}`, ""];
  for (const [index, item] of items.entries()) {
    lines.push(`${index + 1}. ${item.kind} from ${item.from}${item.task === undefined ? "" : ` (task ${item.task})`}`);
    lines.push(item.text);
  }
  return lines.join("\n");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
