/**
 * The Lead mailbox runtime (v0.0.20, ADR 0013 Decisions 3–5): the plugin-side
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
 *     permissions), `rotationState === "normal"`, nothing is in flight, and mail
 *     is queued: batch ALL queued items into one formatted prompt,
 *     `agents.ref(leadAgentId).send(...)`, then append `mail_delivered`;
 *   - `readLeadContextTokens` — the deterministic 128k context sensor (0 LLM
 *     tokens, no 4th agent role): the live snapshot's `lastUsage` first, the
 *     Pi session `.jsonl` at `persistence.nativeHandle` as the fallback across
 *     daemon restarts;
 *   - `pumpProjectLead` — run the lane; while the Lead is `running` over
 *     `LEAD_ROTATE_TOKENS` the pump persists `rotation_pending` and never
 *     interrupts the turn;
 *   - `onLeadTurnEnded` — the turn-boundary state machine (ticket 07): settle
 *     the in-flight batch (`mail_acked` on completed, `mail_requeued` on
 *     failed/canceled), then either complete a handoff (archive the outgoing
 *     Lead, spawn the successor with the roster + digest + handoff kickoff,
 *     reset `normal`, drain the held mail), begin one (lock `handing_over`,
 *     steer the bounded extraction prompt), or drain per ticket 06;
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "./core/factory.ts";
import type { LedgerEvent } from "./core/events.ts";
import { listProjectRegistrations, projectStateDir, readProjectRegistration, resolveProject, writeProjectRegistration } from "./core/project.ts";
import type { LeadRotationState, ProjectRegistration } from "./core/project.ts";
import { taskWorktreeBranch, taskWorktreePath } from "./core/workspace.ts";
import {
  ackLeadMail as appendMailAcked,
  deliverLeadMail as appendMailDelivered,
  enqueueLeadMail as appendMailQueued,
  readLeadMailbox,
  recoverLeadMailbox,
  requeueLeadMail as appendMailRequeued,
} from "./core/mailbox.ts";
import type { LeadMailFrom, LeadMailItem, LeadMailKind } from "./core/mailbox.ts";
import { foldTasks, renderLedgerLine } from "./view.ts";
import type { TaskView } from "../shared/view.ts";
import type { SpoolLeadDispatchRequest, SpoolReply } from "./spool.ts";
import type { SurfaceAgentSnapshot, SurfaceDaemonApi } from "./surface-rpc.ts";

/**
 * The fixed `Lead handoff` threshold (ADR 0013 §5): 128,000 tokens, a
 * constant — never a per-model percentage formula (spec §Out of Scope). The
 * successor rotates before context degradation sets in across any
 * `200k`–`1M` model lane.
 */
export const LEAD_ROTATE_TOKENS = 128_000;

// ---- the deterministic context sensor (ADR 0013 §5, "Reading Lead Context Tokens") ----------

/** What the sensor read, and where it read it from — nulls mean "unknown", never a guess. */
export interface LeadContextTokens {
  usedTokens: number | null;
  maxTokens: number | null;
  source: "daemon" | "session-file";
}

/**
 * Reads one Lead's context-window usage deterministically — 0 LLM tokens, no
 * 4th agent role. Primary: the live daemon snapshot's `lastUsage`
 * (`contextWindowUsedTokens` / `contextWindowMaxTokens`, the SDK's
 * `AgentUsage` fields). Fallback (after a daemon restart, when `lastUsage` is
 * gone): the Pi session `.jsonl` at `persistence.nativeHandle` — the LAST
 * assistant message carrying `usage` answers, computed as
 * `totalTokens || (input + output + cacheRead + cacheWrite)`.
 */
export function readLeadContextTokens(lead: SurfaceAgentSnapshot): LeadContextTokens {
  const used = finiteNumber(lead.lastUsage?.contextWindowUsedTokens);
  if (used !== null) {
    return { usedTokens: used, maxTokens: finiteNumber(lead.lastUsage?.contextWindowMaxTokens), source: "daemon" };
  }
  const native = lead.persistence?.nativeHandle;
  if (typeof native === "string" && native !== "") {
    const fromFile = readLastAssistantUsageTokens(native);
    if (fromFile !== null) return { usedTokens: fromFile, maxTokens: null, source: "session-file" };
  }
  return { usedTokens: null, maxTokens: null, source: "daemon" };
}

/**
 * The `.jsonl` fallback's one read: walk the session file's lines backwards,
 * find the last assistant message carrying a `usage` record (skipping later
 * lines without one), and fold it — `totalTokens` wins when present, else the
 * component sum. Tolerant of the wrapper shapes Pi writes (`message` nested
 * or flat) and of camelCase / snake_case usage keys; anything unreadable is
 * a null, never a guess.
 */
function readLastAssistantUsageTokens(sessionPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a damaged line is skipped, never trusted
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { message?: { role?: unknown; usage?: unknown }; role?: unknown; usage?: unknown };
    const message = record.message !== undefined && typeof record.message === "object" ? record.message : record;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const usage = (message as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const total = finiteNumber(numberAt(usage, ["totalTokens", "total_tokens"]));
    if (total !== null) return total;
    const components = [
      numberAt(usage, ["input", "inputTokens", "input_tokens"]),
      numberAt(usage, ["output", "outputTokens", "output_tokens"]),
      numberAt(usage, ["cacheRead", "cacheReadTokens", "cache_read_input_tokens"]),
      numberAt(usage, ["cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens"]),
    ];
    if (components.every((value) => value === null)) continue;
    return components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  return null;
}

/** The first numeric value among the record's named keys — null when none is a finite number. */
function numberAt(record: object, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber((record as Record<string, unknown>)[key]);
    if (value !== null) return value;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
  ensureLead: (input: { projectRoot: string; message?: string }) => Promise<EnsureLeadResult>;
  /**
   * Retire a Project's Lead (v0.0.20, ADR 0013 §5): the surface handlers'
   * `leadRotate` is the implementation — the `retireSeat` sequence of
   * best-effort cancel, `archive()`, and registration `lead: null`. The
   * handoff's archive step rides it.
   */
  retireLead: (input: { projectRoot: string }) => Promise<{ ok: true; agentId: string } | { ok: false; code: string; error: string }>;
  onLog?: (message: string) => void;
}

/** One runtime's public face — see the module doc for each member's law. */
export interface LeadMailRuntime {
  dispatchLead(request: SpoolLeadDispatchRequest): Promise<SpoolReply>;
  notifyPeer(input: { task: string; kind: "verdict" | "needs_human"; text: string }): Promise<void>;
  enqueueLeadMail(slug: string, mail: { from: LeadMailFrom; kind: LeadMailKind; task?: string; text: string }): Promise<{ mailId: string }>;
  pumpProjectLead(slug: string): Promise<void>;
  /**
   * The turn-boundary state machine (ticket 07): `agent.turn_ended` for a
   * registered Lead, with the event's outcome kind and timeline (structural —
   * no SDK types here). Never rejects; every failure logs and holds.
   */
  onLeadTurnEnded(input: LeadTurnEndedInput): Promise<void>;
  startupRecovery(): void;
}

/** What the `agent.turn_ended` wiring hands the machine — the SDK event reduced to plain data. */
export interface LeadTurnEndedInput {
  agentId: string;
  /**
   * The discriminated turn outcome (`PluginTurnOutcome`'s shape, structural —
   * no SDK types here): only `kind` is interpreted; the failure payloads ride
   * through unexamined for the caller's benefit.
   */
  outcome: { kind: "completed" | "failed" | "canceled"; error?: { message: string; code?: string }; reason?: string };
  timeline: readonly { type: string; text?: string }[];
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

  /** `rotationState` as it sits in `project.json` — the typed field, absent folding to "normal". */
  const readRotationState = (slug: string): LeadRotationState => readProjectRegistration(deps.stateDir, slug)?.rotationState ?? "normal";

  /** Persists a rotation transition under the registry's merge-by-field law (the seats' precedent). */
  const writeRotationState = (slug: string, root: string, patch: { rotationState: LeadRotationState | null; handoffRequestedAt?: string | null }): void => {
    writeProjectRegistration(deps.stateDir, slug, {
      root,
      rotationState: patch.rotationState,
      ...(patch.handoffRequestedAt === undefined ? {} : { handoffRequestedAt: patch.handoffRequestedAt }),
    });
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

  /**
   * The mid-turn rotation observation (ADR 0013 §5): while the Project's Lead
   * is `running`, a context reading at or over `LEAD_ROTATE_TOKENS` persists
   * `rotation_pending` — the deferred boundary. The running turn is NEVER
   * interrupted; the state machine waits for `agent.turn_ended`. A sensor
   * miss (no live Lead, no readable usage, an unreadable daemon) observes
   * nothing — holding `normal` is safe, guessing is the bug.
   */
  const observeRotation = async (slug: string): Promise<void> => {
    if (readRotationState(slug) !== "normal") return; // already pending or locked — nothing to observe
    const registration = readProjectRegistration(deps.stateDir, slug);
    if (registration === undefined) return; // no root binding — nothing to persist against
    const daemon = resolveDaemon();
    const lead = await liveLeadAgent(daemon, slug);
    if (lead === undefined || lead.status !== "running") return;
    const tokens = readLeadContextTokens(lead);
    if (tokens.usedTokens === null || tokens.usedTokens < LEAD_ROTATE_TOKENS) return;
    writeRotationState(slug, registration.root, { rotationState: "rotation_pending" });
    log(`lead-mailbox: ${slug}'s lead crossed ${LEAD_ROTATE_TOKENS} tokens (${tokens.usedTokens}, ${tokens.source}) — rotation pending, the turn runs on`);
  };

  /** Runs the lane — the one door delivery and rotation observation go through. */
  const pumpProjectLead = async (slug: string): Promise<void> => {
    await projectLane(slug, async () => {
      try {
        await observeRotation(slug);
      } catch (err) {
        log(`lead-mailbox: rotation observation of ${slug} failed — the state stands (${messageOf(err)})`);
      }
      try {
        await drainLeadMailbox(slug);
      } catch (err) {
        // A pump failure is a delivery failure, never a mail failure — the
        // batch stays queued and the next pump retries it.
        log(`lead-mailbox: pump of ${slug} failed — the mail stays queued (${messageOf(err)})`);
      }
    });
  };

  /**
   * The turn-boundary state machine (ticket 07, ADR 0013 §5) — serialized on
   * the Project's lane like every other mailbox act. Never rejects: a failed
   * step logs and holds (holding is the safe state, losing is the bug).
   */
  const onLeadTurnEnded = async (input: LeadTurnEndedInput): Promise<void> => {
    // Which Project's Lead ended a turn: the registry's durable binding names it.
    let owned: { slug: string; root: string } | undefined;
    for (const registration of listProjectRegistrations(deps.stateDir)) {
      if (registration.lead === input.agentId) owned = { slug: registration.slug, root: registration.root };
    }
    if (owned === undefined) return; // not a registered Lead's turn — none of this machine's business
    const { slug, root } = owned;
    await projectLane(slug, async () => {
      try {
        await settleTurnAndRotate(slug, root, input);
      } catch (err) {
        log(`lead-mailbox: turn boundary of ${slug}'s lead failed — the state stands, mail is held (${messageOf(err)})`);
      }
    });
  };

  /** The machine's own body — runs inside the lane. */
  const settleTurnAndRotate = async (slug: string, root: string, input: LeadTurnEndedInput): Promise<void> => {
    const path = mailboxPath(slug);
    // (1) Settle the in-flight batch first: `mail_acked` on completed,
    // `mail_requeued` (reason = the outcome kind) otherwise — zero mail lost.
    const state = readLeadMailbox(path);
    if (state.inFlight !== null && state.inFlight.toAgentId === input.agentId) {
      const mailIds = state.inFlight.items.map((item) => item.mailId);
      if (input.outcome.kind === "completed") {
        appendMailAcked(path, { deliveryId: state.inFlight.deliveryId, mailIds, byAgentId: input.agentId });
      } else {
        appendMailRequeued(path, { deliveryId: state.inFlight.deliveryId, mailIds, reason: input.outcome.kind });
        log(`lead-mailbox: ${slug}'s lead turn ${input.outcome.kind} — ${mailIds.length} item(s) requeued`);
      }
    }
    const rotation = readRotationState(slug);
    if (rotation === "handing_over") {
      // (2) The outgoing Lead just finished its Handoff Extraction turn.
      await completeHandoff(slug, root, input);
      return;
    }
    // The boundary sensor reading — best effort; the pending state alone also arms.
    let usedTokens: number | null = null;
    try {
      const lead = await liveLeadAgent(resolveDaemon(), slug);
      if (lead !== undefined) usedTokens = readLeadContextTokens(lead).usedTokens;
    } catch {
      // a sensor miss never blocks the machine
    }
    if ((usedTokens ?? 0) >= LEAD_ROTATE_TOKENS || rotation === "rotation_pending") {
      // (3) Over threshold at the boundary: lock, then steer the one
      // bounded extraction turn. Held mail stays `mail_queued`.
      await beginHandoff(slug, root);
      return;
    }
    // (4) Normal and under threshold: the ticket-06 drain.
    await drainLeadMailbox(slug);
  };

  /** Arm 3 — lock the mailbox (holding all mail), then steer the one bounded Handoff Extraction prompt. */
  const beginHandoff = async (slug: string, root: string): Promise<void> => {
    writeRotationState(slug, root, { rotationState: "handing_over", handoffRequestedAt: new Date().toISOString() });
    const lead = await liveLeadAgent(resolveDaemon(), slug);
    if (lead === undefined) {
      log(`lead-mailbox: ${slug} locked for handoff but no live lead answered — mail holds queued`);
      return; // locked stands; the next turn boundary or ensure re-enters the machine
    }
    await resolveDaemon().agents.ref(lead.id).send(renderHandoffExtractionPrompt(deps.stateDir, slug));
    log(`lead-mailbox: ${slug} locked for handoff — extraction prompt sent to ${lead.id}`);
  };

  /**
   * Arm 2 — the outgoing Lead finished its extraction turn: read (or write,
   * from the turn's assistant text) `lead-handoff.md`, build the
   * machine-verified roster + digest, archive the outgoing Lead, spawn the
   * successor with the three-layer kickoff, reset `normal`, and drain every
   * held mail into it. Any failure holds the lock — mail waits, never drops.
   */
  const completeHandoff = async (slug: string, root: string, input: LeadTurnEndedInput): Promise<void> => {
    const statePath = projectStateDir(deps.stateDir, slug);
    const handoffPath = join(statePath, "lead-handoff.md");
    let handoffText: string | null = null;
    try {
      handoffText = readFileSync(handoffPath, "utf8");
    } catch {
      handoffText = null;
    }
    if ((handoffText === null || handoffText.trim() === "") && input.outcome.kind === "completed") {
      const fromTurn = lastAssistantText(input.timeline);
      if (fromTurn !== null) {
        mkdirSync(statePath, { recursive: true });
        writeFileSync(handoffPath, fromTurn);
        handoffText = fromTurn;
      }
    }
    const events = projectEventsOf(root);
    const roster = renderPeerRoster({
      stateDir: deps.stateDir,
      slug,
      tasks: foldTasks(events),
      agents: agentOfTask(events),
      live: await liveAgentsById(),
    });
    const digest = renderLedgerDigest(events);
    const retired = await deps.retireLead({ projectRoot: root });
    if (!retired.ok) {
      log(`lead-mailbox: handoff of ${slug} could not archive the outgoing lead (${retired.code}: ${retired.error}) — the mailbox stays locked, mail holds queued`);
      return;
    }
    const ensured = await deps.ensureLead({ projectRoot: root, message: renderSuccessorKickoff({ slug, roster, digest, handoffText }) });
    if (!ensured.ok) {
      log(`lead-mailbox: handoff of ${slug} could not spawn the successor (${ensured.code}: ${ensured.error}) — the mailbox stays locked, mail holds queued`);
      return;
    }
    writeRotationState(slug, root, { rotationState: "normal", handoffRequestedAt: null });
    log(`lead-mailbox: handoff of ${slug} complete — ${retired.agentId} archived, successor ${ensured.agentId} kicked off, rotation reset to normal`);
    // The successor just spawned; when it is not yet idle the drain holds one
    // boundary and the successor's own first turn end drains instead.
    await drainLeadMailbox(slug);
  };

  /** The Project's ledger slice — every event whose task's contract workspace sits inside the root (the snapshot's own scoping law). */
  const projectEventsOf = (root: string): readonly LedgerEvent[] =>
    deps.factory.ledger.events.filter((evt) => {
      if (!("task" in evt) || typeof evt.task !== "string") return false;
      const contract = deps.factory.contractFor(evt.task);
      return contract !== undefined && (contract.workspace === root || contract.workspace.startsWith(`${root}/`));
    });

  /** Live daemon agents by id — best effort; a daemon miss renders "(not live)" statuses, never blocks the handoff. */
  const liveAgentsById = async (): Promise<Map<string, SurfaceAgentSnapshot>> => {
    const live = new Map<string, SurfaceAgentSnapshot>();
    try {
      const page = await resolveDaemon().agents.list({ filter: { includeArchived: false } });
      for (const entry of page.entries) live.set(entry.agent.id, entry.agent);
    } catch {
      // the roster renders without live statuses — the ledger half still carries it
    }
    return live;
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
    const rotationState = readRotationState(slug);
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

  return { dispatchLead, notifyPeer, enqueueLeadMail, pumpProjectLead, onLeadTurnEnded, startupRecovery };
}

// ---- the handoff renderers (ADR 0013 §5 — fixed prose, machine-verified payload) ------------

/** The one bounded Handoff Extraction prompt — fixed sections, fixed ceiling, no new work. */
function renderHandoffExtractionPrompt(stateDir: string, slug: string): string {
  return [
    `# Lead handoff extraction — project ${slug}`,
    "",
    "Your context window has crossed the 128,000-token rotation threshold, so this standing Lead seat is rotating: you are being retired, and a fresh successor Lead continues the project from your handoff.",
    "",
    `Write your handoff to ${join(projectStateDir(stateDir, slug), "lead-handoff.md")} now — at most 16 KB, plain Markdown, with exactly these five sections:`,
    "",
    "1. Goal & Remaining Roadmap",
    "2. Uncontracted Next Tasks",
    "3. Key Technical Findings",
    "4. Open Questions",
    "5. Read-First Files",
    "",
    "Start no new tasks, spawn no agents, set no contracts, and accept nothing — the handoff file is this turn's only deliverable. Reply with one line confirming the file is written.",
  ].join("\n");
}

/** The successor's three-layer kickoff — roster, digest, and the outgoing Lead's handoff text. */
function renderSuccessorKickoff(input: { slug: string; roster: string; digest: string; handoffText: string | null }): string {
  return [
    `# Lead handoff — project ${input.slug}`,
    "",
    "You are the fresh successor Lead of this project, spawned at 0% context after the outgoing Lead crossed the 128,000-token rotation threshold. Three layers of continuity follow — the first two are machine-verified, built by the plugin from the live daemon and the ledger, never from prose:",
    "",
    "## Machine-Verified Active Peer Roster",
    "",
    input.roster,
    "",
    "## Ledger State Digest",
    "",
    input.digest,
    "",
    "## Outgoing Lead handoff (lead-handoff.md)",
    "",
    input.handoffText !== null && input.handoffText.trim() !== ""
      ? input.handoffText
      : "(the outgoing Lead left no handoff text — rely on the roster and digest above, then read the ledger and reports)",
  ].join("\n");
}

/**
 * The Machine-Verified Active Peer Roster: every Task in the Project with its
 * fold status, its bound agent and live daemon status, the Task worktree path
 * and branch, and the latest Attempt / Verdict / Report — the `taskWorktree*`
 * and `agentTaskIndex` precedents rendered as the successor's ground truth.
 */
function renderPeerRoster(input: {
  stateDir: string;
  slug: string;
  tasks: readonly TaskView[];
  agents: ReadonlyMap<string, string>;
  live: ReadonlyMap<string, SurfaceAgentSnapshot>;
}): string {
  if (input.tasks.length === 0) return "(no tasks in the project's ledger — a clean slate)";
  const lines: string[] = [];
  for (const task of input.tasks) {
    const agentId = input.agents.get(task.task);
    const liveStatus = agentId === undefined ? null : (input.live.get(agentId)?.status ?? "(not live on the daemon)");
    const latest = task.attempts.at(-1);
    lines.push(
      [
        `- task ${task.task}: status ${task.status}`,
        agentId === undefined ? "agent (none bound)" : `agent ${agentId} (live: ${liveStatus})`,
        `worktree ${taskWorktreePath(input.stateDir, input.slug, task.task)} (branch ${taskWorktreeBranch(task.task)})`,
        latest === undefined ? "no attempt yet" : `latest attempt #${latest.n} (verdict: ${latest.verdict ?? "none yet"})`,
        `report: ${latest?.report ?? "none"}`,
      ].join(" · "),
    );
  }
  return lines.join("\n");
}

/** How many ledger lines ride the digest — orientation, not a mirror (the ledger stays on disk). */
const LEDGER_DIGEST_LINES = 20;

/** The Ledger State Digest: the Project's event census plus the most recent rendered lines. */
function renderLedgerDigest(events: readonly LedgerEvent[]): string {
  if (events.length === 0) return "(the project's ledger is empty)";
  const counts = new Map<string, number>();
  for (const evt of events) counts.set(evt.event, (counts.get(evt.event) ?? 0) + 1);
  const census = [...counts.entries()].sort().map(([name, count]) => `${name}×${count}`).join(", ");
  const tail = events.slice(-LEDGER_DIGEST_LINES).map((evt) => `seq ${evt.seq} — ${renderLedgerLine(evt)}`);
  return [`${events.length} ledger line(s) under <projectStateDir>/ledger.jsonl: ${census}`, ...tail].join("\n");
}

/** The task → agent binding, from the ledger's own names (the `agentTaskIndex` precedent, inverted). */
function agentOfTask(events: readonly LedgerEvent[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const evt of events) {
    if (evt.event !== "claim_reported" && evt.event !== "meter_written" && evt.event !== "repoke_dispatched") continue;
    if (typeof evt.agent === "string" && evt.agent !== "") index.set(evt.task, evt.agent);
  }
  return index;
}

/** The timeline's last assistant text — the handoff-file fallback's source. */
function lastAssistantText(timeline: readonly { type: string; text?: string }[]): string | null {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i]!;
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim() !== "") return item.text;
  }
  return null;
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
