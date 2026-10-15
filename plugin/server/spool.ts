/**
 * The spool (ADR 0004): the plugin process is the only Ledger writer and the
 * only Gate runner; the CLIs (`factory-claim`, `factory contract`,
 * `factory accept`) only submit. A CLI drops a request file and waits for the
 * reply file — no RPC, no shared process, so the protocol survives daemon
 * restarts and never hands the Ledger to an agent's process.
 *
 * Protocol — the plugin side lives here, the CLI side in
 * `plugin/bin/spool-client.mjs`, and `test/cli.test.ts` runs both halves
 * against each other so they cannot drift:
 *
 *   request:  spool/requests/<id>.json   {id, kind, ...}   written atomically
 *   reply:    spool/replies/<id>.json    {id, ok, ...}     written atomically
 *   handled:  spool/processed/<id>.json  the request file, moved after reply
 *
 * Each request carries an id: a request whose reply already exists is moved
 * along untouched, so a retried or replayed request never starts a second
 * Gate. What a plugin crash mid-gate looks like is ADR 0003's business — the
 * interrupted Attempt is closed red on the next open, and the still-unreplied
 * request is processed again on boot, opening the next Attempt honestly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import { usageIsValid } from "./core/ledger.ts";
import { needsHumanEvidenceIsValid, NEEDS_HUMAN_REASONS } from "./core/events.ts";
import type { Factory } from "./core/factory.ts";
import type { LedgerEvent, MeterUsage, NeedsHumanEvidence, NeedsHumanReason, Verdict } from "./core/events.ts";

export interface ContractRequest {
  id: string;
  kind: "contract";
  task: string;
  workspace: string;
  gate: string;
  artifact: string;
  scope?: string[];
  /** Marks the fresh-eyes pass ON (ADR 0005 default: off). Exactly `true` passes; anything else is rejected. */
  freshEyes?: true;
  /** Marks the watch pass ON (v0.0.6, record-only, both verdicts). Exactly `true` passes; anything else is rejected. */
  watch?: true;
  /** The task's assignment text (v0.0.6 description-slot rider) — the driver's brief carries it. */
  description?: string;
  /**
   * The SKILL.md workflows the working Agent must open first (v0.0.14, ADR
   * 0010 §6) — skill names; the driver's brief renders them at the top.
   */
  skills?: string[];
  /**
   * Who submitted (v0.0.9, ADR 0006) — required, stamped by the CLI from the
   * submitting shell's env: the delegated Owner agent's `PASEO_AGENT_ID`
   * where the daemon carried one, `owner` on the human path. An unstamped
   * contract is malformed — attribution is part of the request's shape, so
   * the spool never guesses or defaults it.
   */
  submitter: string;
}

export interface ClaimRequest {
  id: string;
  kind: "claim";
  task: string;
  sha: string;
  /** Who submitted, when the daemon stamps it on the agent's env — for the spool log, not the ledger. */
  agent?: string;
}

export interface AcceptRequest {
  id: string;
  kind: "accept";
  task: string;
  attempt: number;
  /**
   * The accepting seat, claimed explicitly (v0.0.14, ADR 0010 §3): the CLI's
   * `--by owner|supervisor|lead` flag. When present it overrides the
   * submitter stamp as the acceptance's `accepted_by` — the Lead's
   * conditional authority is judged at the factory, never trusted from the
   * request's spelling alone.
   */
  by?: "owner" | "supervisor" | "lead";
  /**
   * Who submitted (v0.0.9) — required, the submitting shell's stamp, the
   * same law as the contract's: `PASEO_AGENT_ID` or `owner`. "The Ledger
   * always records who accepted" (ADR 0006) starts at the request.
   */
  submitter: string;
}

/**
 * A driver's spawn request (v0.0.5, ADR 0004 amendment): `factory run` asks
 * the plugin — the one writer — whether it may create this task's agent.
 * The plugin judges (task state, scope-mandatory at arity ≥ 2, workspace
 * overlap) and appends one ledger line either way; only on ok does the
 * driver perform its own daemon RPC create. `provider` is recorded on the
 * line, never interpreted; `arity` is the invocation's task count — the
 * parallel width the scope rule keys on.
 */
export interface SpawnRequest {
  id: string;
  kind: "spawn";
  task: string;
  provider: string;
  arity: number;
  /**
   * The managed Task worktree this run executes in (v0.0.14, ADR 0010 §4) —
   * the driver allocates it pre-spawn and names it here; the plugin records
   * it on `spawn_dispatched`, and claim / gate / choke binding resolve
   * through it. Optional: the legacy shared-checkout path sends none.
   */
  worktree?: string;
}

/**
 * The Lead's one automatic Respawn per progress marker (v0.0.12, ADR 0008):
 * when an Agent dies (`Substrate death`), the driver asks the plugin — the
 * one writer — whether it may replace the dead Agent, and only creates the
 * replacement after an ok. The reply carries `event` (whose `seq` keys the
 * replacement `agent.create.request` idempotency key).
 */
export interface RespawnRequest {
  id: string;
  kind: "respawn";
  task: string;
  provider: string;
  died_agent: string;
}

/**
 * The Owner's Retro request (v0.0.7, ticket 03 item 2): `factory retro`
 * drops this and the plugin does everything — digest, copilot pass,
 * proposals file, the one factory-level `retro_written` line (the one-writer
 * law). Deliberately a NEW kind, not a contract reuse: different validation,
 * different act. No arguments exist to carry: whole-ledger always, no
 * `--since`, no task filter (v1).
 */
export interface RetroRequest {
  id: string;
  kind: "retro";
}

/**
 * The driver's meter request (v0.0.8, ticket 03 item 1 — ADR 0004's third
 * amendment): the usage snapshot the driver captured off its terminal
 * `fetch_agent` poll, submitted for the plugin to validate and ledger as
 * one `meter_written` line. The driver never writes the ledger; a refused
 * meter (unknown task, malformed shape) errors back with no line — nothing
 * changed, nothing recorded. `usage` rides the daemon's camelCase verbatim,
 * each field present only when the lane provided it.
 */
export interface MeterRequest {
  id: string;
  kind: "meter";
  task: string;
  /** The `provider[/model]` string the driver's invocation ran under, verbatim. */
  provider: string;
  /** The daemon's usage snapshot — see `MeterUsage` in core/events.ts. */
  usage: MeterUsage;
  /** The metered agent's id, when the driver knows it. */
  agent?: string;
}

/**
 * The Lead's one spend (v0.0.10, ticket 03 item 3 — the spawn precedent's
 * strict shape): the driver asks the plugin — the one writer — whether it
 * may spend the task's one re-poke, and only sends the fixed message after
 * an ok. The plugin holds the structural laws (task known, not accepted,
 * not already spent); the stall predicate that triggered the ask stays
 * driver-side. Deliberately minimal — the trigger is the driver's fact, the
 * spend is the plugin's authority, and neither interprets the other.
 */
export interface RepokeRequest {
  id: string;
  kind: "repoke";
  task: string;
  /** The stalled agent the fixed re-poke text goes to. */
  agent: string;
}

/**
 * The Lead's named end (v0.0.10 / v0.0.12, ADR 0008): the task reached one
 * of the four `NeedsHuman` conditions (`denied-again`, `silent-after-repoke`,
 * `attempt-ceiling`, `died-after-respawn`), so the driver submits the fact
 * for the plugin to corroborate and ledger as one task-scoped `needs_human`
 * line with its matching evidence pair.
 */
export interface NeedsHumanRequest {
  id: string;
  kind: "needs_human";
  task: string;
  reason: NeedsHumanReason;
  evidence: NeedsHumanEvidence;
}

/**
 * A synthetic permit ask (v0.0.4) — the bypass battery's vehicle into the real
 * choke: the same policy, the same ledger lines, answered in the reply instead
 * of `respondToPermission()` because no daemon ask exists to answer. The task
 * must carry a live Contract covering `cwd` (default: the Contract's own
 * workspace) — the choke judges contracted work only.
 */
export interface AskRequest {
  id: string;
  kind: "ask";
  task: string;
  command: string;
  cwd?: string;
  agent?: string;
  name?: string;
}

export type SpoolRequest =
  | ContractRequest
  | ClaimRequest
  | AcceptRequest
  | AskRequest
  | SpawnRequest
  | RespawnRequest
  | MeterRequest
  | RepokeRequest
  | NeedsHumanRequest
  | RetroRequest;

/** Handles a synthetic ask — `createChoke(...).spoolAskHandler` is the implementation. */
export type AskHandler = (request: AskRequest) => SpoolReply;

export type SpoolReply =
  | {
      id: string;
      ok: true;
      summary: string;
      /** Claim replies: which Attempt the Claim opened and how it ended. */
      attempt?: number;
      verdict?: Verdict;
      reportPath?: string;
      /** The gate note — the agent's actionable feedback on a red verdict. */
      note?: string;
      /** Ask replies: the choke's answer. A denial is a processed ask, not an error. */
      decision?: "allowed" | "denied";
      rule?: string;
      reason?: string;
      /** Retro replies: the proposals file and its count (the success stdout's two facts). */
      proposalsPath?: string;
      proposalCount?: number;
      /** Spawn / respawn replies: the ledger event appended for the request (carries seq). */
      event?: LedgerEvent;
    }
  | { id: string; ok: false; code: string; message: string; event?: LedgerEvent };

/** Where all three spool directories live. */
export function spoolRootFor(stateDir: string): string {
  return join(stateDir, "spool");
}

/**
 * Validates one decoded request body. Anything that does not match a kind's
 * exact shape is rejected — the spool never guesses what a CLI meant.
 */
export function parseSpoolRequest(body: unknown): SpoolRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const req = body as Record<string, unknown>;
  if (typeof req.id !== "string" || req.id === "") return undefined;
  if (req.kind === "contract") {
    if (typeof req.task !== "string" || typeof req.workspace !== "string" || typeof req.gate !== "string" || typeof req.artifact !== "string") {
      return undefined;
    }
    // The v0.0.9 stamp: a contract without a submitter is malformed — the
    // spool never defaults an unstamped Owner act to anyone.
    if (typeof req.submitter !== "string" || req.submitter.trim() === "") return undefined;
    const scope = req.scope;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== "string"))) return undefined;
    const skills = req.skills;
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((s) => typeof s !== "string"))) return undefined;
    if (req.freshEyes !== undefined && req.freshEyes !== true) return undefined;
    if (req.watch !== undefined && req.watch !== true) return undefined;
    if (req.description !== undefined && (typeof req.description !== "string" || req.description.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: "contract",
      task: req.task,
      workspace: req.workspace,
      gate: req.gate,
      artifact: req.artifact,
      ...(scope === undefined ? {} : { scope: scope as string[] }),
      ...(skills === undefined ? {} : { skills: skills as string[] }),
      ...(req.freshEyes === undefined ? {} : { freshEyes: true }),
      ...(req.watch === undefined ? {} : { watch: true }),
      ...(req.description === undefined ? {} : { description: req.description }),
      submitter: req.submitter,
    };
  }
  if (req.kind === "claim") {
    if (typeof req.task !== "string" || typeof req.sha !== "string") return undefined;
    if (req.agent !== undefined && typeof req.agent !== "string") return undefined;
    return { id: req.id, kind: "claim", task: req.task, sha: req.sha, ...(req.agent === undefined ? {} : { agent: req.agent }) };
  }
  if (req.kind === "accept") {
    if (typeof req.task !== "string" || typeof req.attempt !== "number" || !Number.isInteger(req.attempt)) return undefined;
    // Same law as the contract: no submitter, no acceptance — the accepter's
    // identity is part of the act (ADR 0006).
    if (typeof req.submitter !== "string" || req.submitter.trim() === "") return undefined;
    if (req.by !== undefined && req.by !== "owner" && req.by !== "supervisor" && req.by !== "lead") return undefined;
    return {
      id: req.id,
      kind: "accept",
      task: req.task,
      attempt: req.attempt,
      ...(req.by === undefined ? {} : { by: req.by }),
      submitter: req.submitter,
    };
  }
  if (req.kind === "spawn") {
    if (typeof req.task !== "string" || typeof req.provider !== "string" || typeof req.arity !== "number" || !Number.isInteger(req.arity) || req.arity < 1) {
      return undefined;
    }
    if (req.worktree !== undefined && (typeof req.worktree !== "string" || req.worktree.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: "spawn",
      task: req.task,
      provider: req.provider,
      arity: req.arity,
      ...(req.worktree === undefined ? {} : { worktree: req.worktree }),
    };
  }
  if (req.kind === "respawn") {
    if (
      typeof req.task !== "string" ||
      typeof req.provider !== "string" ||
      req.provider.trim() === "" ||
      typeof req.died_agent !== "string" ||
      req.died_agent.trim() === ""
    ) {
      return undefined;
    }
    return { id: req.id, kind: "respawn", task: req.task, provider: req.provider, died_agent: req.died_agent };
  }
  if (req.kind === "retro") {
    // The Retro carries nothing but its kind — whole-ledger always. The
    // strict shape is the point: any extra field makes it not-a-retro.
    const keys = Object.keys(req).filter((key) => key !== "id" && key !== "kind");
    if (keys.length > 0) return undefined;
    return { id: req.id, kind: "retro" };
  }
  if (req.kind === "meter") {
    if (typeof req.task !== "string" || typeof req.provider !== "string" || req.provider.trim() === "") return undefined;
    if (req.agent !== undefined && typeof req.agent !== "string") return undefined;
    // Usage keeps the daemon's camelCase verbatim, but only the four metered
    // fields may ride — the spool never guesses what a lane meant.
    if (!usageIsValid(req.usage)) return undefined;
    const usage = { ...(req.usage as Record<string, number>) } as MeterRequest["usage"];
    return {
      id: req.id,
      kind: "meter",
      task: req.task,
      provider: req.provider,
      usage,
      ...(req.agent === undefined ? {} : { agent: req.agent }),
    };
  }
  if (req.kind === "repoke") {
    if (typeof req.task !== "string" || typeof req.agent !== "string" || req.agent.trim() === "") return undefined;
    return { id: req.id, kind: "repoke", task: req.task, agent: req.agent };
  }
  if (req.kind === "needs_human") {
    if (typeof req.task !== "string") return undefined;
    if (typeof req.reason !== "string" || !(NEEDS_HUMAN_REASONS as readonly string[]).includes(req.reason)) return undefined;
    const reason = req.reason as NeedsHumanReason;
    if (!needsHumanEvidenceIsValid(req.evidence, reason)) return undefined;
    return { id: req.id, kind: "needs_human", task: req.task, reason, evidence: req.evidence };
  }
  if (req.kind === "ask") {
    if (typeof req.task !== "string" || typeof req.command !== "string" || req.command.trim() === "") return undefined;
    for (const field of ["cwd", "agent", "name"] as const) {
      if (req[field] !== undefined && typeof req[field] !== "string") return undefined;
    }
    return {
      id: req.id,
      kind: "ask",
      task: req.task,
      command: req.command,
      ...(req.cwd === undefined ? {} : { cwd: req.cwd as string }),
      ...(req.agent === undefined ? {} : { agent: req.agent as string }),
      ...(req.name === undefined ? {} : { name: req.name as string }),
    };
  }
  return undefined;
}

/**
 * Runs one request through the factory — the single place a spool request
 * becomes Ledger events or a Gate run. Never throws: every failure becomes a
 * red-flagged reply, so the waiting CLI always hears something. `ask` requests
 * need the choke's handler (the shell passes `createChoke(...).spoolAskHandler`);
 * without one they are refused loudly, never silently allowed.
 */
export async function handleSpoolRequest(
  factory: Factory,
  request: SpoolRequest,
  askHandler?: AskHandler,
): Promise<SpoolReply> {
  try {
    if (request.kind === "contract") {
      factory.setContract({
        task: request.task,
        workspace: request.workspace,
        gate: request.gate,
        artifact: request.artifact,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        ...(request.skills === undefined || request.skills.length === 0 ? {} : { skills: request.skills }),
        ...(request.freshEyes === undefined ? {} : { freshEyes: true }),
        ...(request.watch === undefined ? {} : { watch: true }),
        ...(request.description === undefined ? {} : { description: request.description }),
        by: request.submitter,
      });
      return {
        id: request.id,
        ok: true,
        summary:
          `contract set for ${request.task}: \`${request.gate}\` in ${request.workspace}` +
          `${request.freshEyes === true ? " · fresh eyes ON" : ""}${request.watch === true ? " · watch ON" : ""} · by ${request.submitter}`,
      };
    }
    if (request.kind === "claim") {
      const outcome = await factory.claim({
        task: request.task,
        sha: request.sha,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      return {
        id: request.id,
        ok: true,
        summary: `task ${request.task} attempt ${outcome.attempt}: ${outcome.verdict.toUpperCase()}`,
        attempt: outcome.attempt,
        verdict: outcome.verdict,
        reportPath: outcome.reportPath,
        note: outcome.gate.note,
      };
    }
    if (request.kind === "ask") {
      if (askHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "ask-unavailable",
          message: "this daemon's factory plugin does not judge synthetic asks — update the plugin to v0.0.4+",
        };
      }
      return askHandler(request);
    }
    if (request.kind === "spawn") {
      // The driver's arrival (v0.0.5): one ledger line either way, then the
      // reply the driver keys its next move on — create the agent, or report
      // the refusal and carry on with the invocation's other tasks. The
      // worktree (v0.0.14) rides the line so claim/gate/choke bind to it.
      const decision = factory.requestSpawn({
        task: request.task,
        provider: request.provider,
        arity: request.arity,
        ...(request.worktree === undefined ? {} : { worktree: request.worktree }),
      });
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason, event: decision.event };
      }
      return {
        id: request.id,
        ok: true,
        summary: `spawn dispatched for ${request.task} under ${request.provider} (n=${request.arity})`,
        event: decision.event,
      };
    }
    if (request.kind === "respawn") {
      // The Lead's one automatic Respawn per progress marker (v0.0.12, ADR 0008):
      // one ledger line either way, with `event` attached so the driver can key
      // the replacement `agent.create.request` by `${task}-respawn-${event.seq}`.
      const decision = factory.respawn({
        task: request.task,
        provider: request.provider,
        died_agent: request.died_agent,
      });
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason, event: decision.event };
      }
      return {
        id: request.id,
        ok: true,
        summary: `respawn dispatched for ${request.task} under ${request.provider} (replacing ${request.died_agent.slice(0, 12)})`,
        event: decision.event,
      };
    }
    if (request.kind === "meter") {
      // The driver's post-verdict capture (v0.0.8): one line, validated and
      // appended. The reply's summary carries the dollars the lane reported
      // (or their named absence) — the driver's log line is where the run's
      // cost first becomes visible to the operator.
      const event = factory.meter({
        task: request.task,
        provider: request.provider,
        usage: request.usage,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      const dollars = event.usage.totalCostUsd;
      const cost = dollars === undefined ? "no dollars reported (recorded as absent)" : `$${dollars.toFixed(2)}`;
      return { id: request.id, ok: true, summary: `meter for ${request.task} under ${request.provider}: ${cost}` };
    }
    if (request.kind === "repoke") {
      // The Lead's one spend (v0.0.10): one ledger line either way — the
      // dispatch line is the spent marker, and every refusal is a recorded
      // fact. Only on ok does the driver send its fixed message.
      const decision = factory.repoke(request.task, request.agent);
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason };
      }
      return {
        id: request.id,
        ok: true,
        summary: `re-poke dispatched for ${request.task} → agent ${request.agent.slice(0, 12)} — the task's one spend`,
      };
    }
    if (request.kind === "needs_human") {
      // The stall's or ceiling's named end (v0.0.10 / v0.0.12): one line,
      // evidence pair attached. The meter's law — a refused submission throws,
      // no line, and the reply carries the code so the driver can report it.
      const event = factory.needsHuman({ task: request.task, reason: request.reason, evidence: request.evidence });
      const detail =
        "denial" in event.evidence
          ? `denial seq ${event.evidence.denial}, repoke seq ${event.evidence.repoke}`
          : "attempt" in event.evidence
            ? `attempt ${event.evidence.attempt}, gate seq ${event.evidence.gate}`
            : `spawn seq ${event.evidence.spawn}, respawn seq ${event.evidence.respawn}`;
      return {
        id: request.id,
        ok: true,
        summary: `needs-human for ${request.task}: ${event.reason} (${detail})`,
      };
    }
    if (request.kind === "retro") {
      // The Owner's on-demand pass (v0.0.7): the plugin runs it whole. A
      // `failed` outcome already ledgered its visible line — the reply still
      // refuses (exit 2), so the Owner sees the error at the terminal too.
      const outcome = await factory.retro();
      if (outcome.outcome === "failed") {
        return { id: request.id, ok: false, code: "retro-failed", message: outcome.error ?? "(no reason recorded)" };
      }
      return {
        id: request.id,
        ok: true,
        summary: `retro written: ${outcome.proposalCount} proposals → ${outcome.proposalsPath}`,
        proposalsPath: outcome.proposalsPath,
        proposalCount: outcome.proposalCount,
      };
    }
    // The acceptance (v0.0.14): awaited — a worktree task's local landing
    // runs before the line records, and the reply carries the outcome. The
    // `--by` seat, when the request claims one, overrides the submitter
    // stamp; the Lead's conditional authority is judged below in the factory.
    const acceptedBy = request.by ?? request.submitter;
    const accepted = await factory.accept({ task: request.task, attempt: request.attempt, accepted_by: acceptedBy });
    return {
      id: request.id,
      ok: true,
      summary:
        `task ${request.task} accepted at attempt ${request.attempt} by ${acceptedBy}` +
        (accepted.landing === "landed"
          ? " · landed into <project-root>"
          : accepted.landing === "pending-conflict"
            ? ` · landing pending-conflict: ${accepted.landingNote ?? "(no reason recorded)"} — branch factory/${request.task} is preserved`
            : ""),
    };
  } catch (err) {
    if (err instanceof FactoryError) {
      return { id: request.id, ok: false, code: err.code, message: err.message };
    }
    return {
      id: request.id,
      ok: false,
      code: "plugin-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SpoolOptions {
  /** Called once per handled request — the shell prefixes and prints it. */
  onLog?: (message: string) => void;
  /** Reply poll cadence for the drain loop. Default 250ms. */
  pollMs?: number;
  /** The choke's synthetic-ask handler (v0.0.4); without it `ask` requests are refused. */
  ask?: AskHandler;
}

export interface Spool {
  stop(): void;
}

/**
 * The submit side of the loop: poll `requests/`, handle each new id, write the
 * reply, move the request to `processed/`. Requests are handled concurrently —
 * a long Gate must not delay the Owner's contract or accept — which is safe
 * because the factory itself refuses overlapping Attempts on one task.
 */
export function startSpool(stateDir: string, factory: Factory, options: SpoolOptions = {}): Spool {
  const root = spoolRootFor(stateDir);
  const requestsDir = join(root, "requests");
  const repliesDir = join(root, "replies");
  const processedDir = join(root, "processed");
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(repliesDir, { recursive: true });
  mkdirSync(processedDir, { recursive: true });

  const log = options.onLog ?? (() => {});
  const inFlight = new Set<string>();

  const drain = (): void => {
    for (const name of readdirSync(requestsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (inFlight.has(id)) continue;
      const requestPath = join(requestsDir, name);
      const replyPath = join(repliesDir, name);
      if (existsSync(replyPath)) {
        // Already answered (retried or replayed request): pass it along, run nothing.
        renameSync(requestPath, join(processedDir, name));
        log(`request ${id}: reply already existed — skipped (no second gate)`);
        continue;
      }
      inFlight.add(id);
      void handleRequestFile(id, requestPath, replyPath, join(processedDir, name), factory, log, options.ask)
        .catch(() => {})
        .finally(() => inFlight.delete(id));
    }
  };

  const timer = setInterval(drain, options.pollMs ?? 250);
  drain();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function handleRequestFile(
  id: string,
  requestPath: string,
  replyPath: string,
  processedPath: string,
  factory: Factory,
  log: (message: string) => void,
  askHandler?: AskHandler,
): Promise<void> {
  let reply: SpoolReply;
  let request: SpoolRequest | undefined;
  try {
    request = parseSpoolRequest(JSON.parse(readFileSync(requestPath, "utf8")));
  } catch {
    request = undefined;
  }
  if (request === undefined) {
    reply = { id, ok: false, code: "bad-request", message: `request file ${requestPath} is not a valid spool request` };
    log(`request ${id}: REJECTED — malformed`);
  } else {
    reply = await handleSpoolRequest(factory, request, askHandler);
    // The v0.0.9 stamps make the two Owner acts attributable in the log too —
    // the same visibility the claim line always had.
    const stamp = request.kind === "contract" || request.kind === "accept" ? ` by ${request.submitter}` : "";
    log(
      request.kind === "claim" && reply.ok
        ? `request ${id}: claim ${request.task} by ${request.agent ?? "unknown agent"} → attempt ${reply.attempt} ${reply.verdict}`
        : `request ${id}: ${request.kind}${"task" in request ? ` ${request.task}` : ""}${stamp} → ${reply.ok ? (reply.decision ?? "ok") : `rejected (${reply.code})`}`,
    );
  }
  writeJsonAtomic(replyPath, reply);
  renameSync(requestPath, processedPath);
}

/** Write-then-rename, so a reader never sees a half-written JSON file. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}
