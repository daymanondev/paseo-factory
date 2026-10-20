#!/usr/bin/env node
/**
 * The driver behind `factory run` (v0.0.5 ticket 04) — spawn, refuse, guard.
 *
 * Laws it lives under:
 *
 * - **One writer (ADR 0004):** the driver never writes the ledger. It submits
 *   a `spawn` request per task through the spool and reads the plugin's
 *   reply; verdicts are read back from the ledger the plugin maintains (the
 *   same read-only read `factory status` does). Since v0.0.8 the meter rides
 *   the same law: the driver captures the daemon's usage snapshot at each
 *   task's terminal moment and submits one `meter` request — the plugin
 *   validates and appends `meter_written`. Since v0.0.10 the Lead's two acts
 *   ride it too: one `repoke` request (the task's one spend — the plugin
 *   holds the one-per-task law) and one `needs_human` request (the stall's
 *   named end), each a plugin-written ledger line.
 * - **Zero runtime deps:** node's built-in `WebSocket` + `node:fs` +
 *   `node:child_process`, nothing else. The daemon WS protocol is
 *   source-verified against `@getpaseo/client` 0.10.3 (v0.0.5 ticket 01's
 *   scout): hello with the local credential, then JSON RPC in
 *   `{type:"session", message:{…}}` envelopes, responses matched by
 *   requestId. `paseo.pid` and `local-credential` are re-read on every
 *   connect — both are rewritten on daemon restart.
 * - **One automatic Respawn per progress marker (v0.0.12, ADR 0008):** on
 *   `Substrate death` the Lead meters the dead agent and submits one `respawn`
 *   request through the spool — the plugin enforces the one-per-progress-marker
 *   (`spawn_dispatched` or `gate_finished`) and `MAX_ATTEMPTS = 3` laws. A
 *   second death without a new Attempt ends in `needs_human ("died-after-respawn")`.
 *   Create RPCs are idempotency-keyed by `${task}-spawn-${seq}` /
 *   `${task}-respawn-${seq}` (falling back to `task`), so a replayed socket
 *   meets the same operation while each distinct dispatch gets its own key.
 * - **The Lead rider (v0.0.10, ADR 0006 §3):** the watch loop carries the
 *   Lead's denial-stall predicate as a rider — the announced path to a
 *   standing plugin loop. Zero model calls: the predicate is ledger
 *   arithmetic, the re-poke is fixed text, `needs_human` is a recorded fact.
 *   Riding the same branches sits the death classifier (v0.0.11, ADR 0007):
 *   the null fetch is an empty signal, so the null lane reads the daemon
 *   timeline — the death oracle. Two doors: the timeline's own error answer
 *   ("Agent not found") is the fast door; an answering timeline whose
 *   `seqEnd` never grows for the bound is the slow door. Post-spawn ledger
 *   life stays defense-in-depth on the fast door only — contradicted, the
 *   watch survives on the ledger predicate, and no meter is submitted at a
 *   death the ledger contradicts.
 *
 * Plain .mjs like its siblings: the daemon's node may lack TypeScript
 * stripping, and CLIs import no plugin server code (ADR 0004).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readLedgerEvents } from "./ledger-read.mjs";
import { awaitReply, randomId, submit } from "./spool-client.mjs";
import { prepareTaskWorkspace } from "./task-worktree.mjs";

/** Snapshot polling cadence — the observe loop's only clock (ticket 03 §5). */
export const POLL_MS = 5_000;
/** Spawns stagger a few seconds apart — CPU etiquette, not correctness (ticket 03 §7). */
export const STAGGER_MS = 3_000;
/** Stall is report-only: status `running` with no timeline growth (or an ask parked this long) warns once. */
export const STALL_WARN_MS = 10 * 60_000;
/**
 * The slow door's bound (ADR 0007): a timeline that answers but shows no
 * `seqEnd` growth for this long is a death — healthy ask-less work streams
 * timeline items continuously, so this much stillness is true death. Fixed
 * in code, never configuration.
 */
export const ZERO_GROWTH_DEAD_MS = 2 * 60_000;
/**
 * The Lead's denial-stall grace (v0.0.10 design §1): how long after a denial
 * the predicate waits before calling the stall — the denial ends the turn
 * within seconds (measured, v0.0.8), so 30 s sits safely past it with ~70 s
 * of headroom under the ~106 s false-death window. Fixed in code, never
 * configuration.
 */
export const GRACE_MS = 30_000;
/**
 * How long a spent re-poke stays answerable before the Lead writes
 * `needs_human` (v0.0.10 design §3): no task event and no claim after the
 * poke for this long is silence — the `STALL_WARN_MS` precedent's own size.
 */
export const RE_STALL_MS = 10 * 60_000;
/**
 * The Attempt ceiling (ADR 0008 §1): a Task may open at most 3 Attempts.
 * Mirrored from `src/events.ts` because CLIs import no `src/` code (ADR 0004).
 */
export const MAX_ATTEMPTS = 3;
/** Creating an agent runs the before-hooks and boots a provider session — this is not a fast RPC. */
const CREATE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** How long the Lead's spool replies may take — the plugin answers without running anything (the meter's wait). */
const LEAD_WAIT_MS = 15_000;
/** How long the re-poke's daemon send may take to be answered on the session socket. */
const SEND_WAIT_MS = 15_000;

// Mirrors TASK_ID_PATTERN in src/factory.ts — the CLIs import no src/ code
// (ADR 0004); the driver checks it before the id becomes a git branch name.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The runbook's fixed brief (docs/runbooks/live-run.md step 5) — only the
// placeholders and the baked PATH vary, never the words. Since v0.0.6 a
// contract's description rides ahead of the fixed body (the description-slot
// rider): the assignment reaches the agent in the brief itself, retiring the
// v0.0.5 TASK.md seed workaround. Since v0.0.14 a contract's skills ride
// above everything (ADR 0010 §6): `Required skills to open first: <skills>`
// mandates the SKILL.md workflows the working Agent opens before it starts.
// Since v0.0.16 the mandate also names WHERE each SKILL.md lives (ADR 0011):
// the working Agent's Pi harness home filters <available_skills> down to
// tdd, diagnosing-bugs, codebase-design, so a Contract-mandated skill beyond
// those three must be opened by path — `~/.agents/skills/<skill>/SKILL.md`
// (or `.agents/skills/<skill>/SKILL.md` in the Workspace) — on demand.
// No description and no skills, no headers — the brief is byte-identical to
// v0.0.5's.
const BRIEF_TEMPLATE = `Do the assigned work on branch \`<branch>\`. When done: commit, run
\`git rev-parse HEAD\`, then \`factory-claim --task <task-id> --sha <sha>\`.
If the result is RED: read the note line, fix, make a NEW commit, claim
again with the new sha. Never edit tests just to make them green.

Your shells under the daemon start without git/node/npm on PATH — export
PATH="<path>" first.`;

/**
 * The brief, rendered per task — `<task-id>` is the task id and `<branch>` the
 * branch argument (the task id on the legacy shared-checkout path, its
 * `factory/<task>` worktree branch since v0.0.14); the PATH is baked from the
 * driver's own environment at spawn time; the contract's description (when
 * set) rides ahead as the assignment header, and its skills (when set) ride
 * at the very top as the method mandate — since v0.0.16 with the read-first
 * path instruction, so the Agent can open any SKILL.md its filtered
 * <available_skills> no longer preloads.
 */
export function renderBrief(task, pathValue, description, skills, branch = task) {
  const body = BRIEF_TEMPLATE.replaceAll("<branch>", branch)
    .replaceAll("<task-id>", task)
    .replace('PATH="<path>" first.', `PATH="${pathValue}" first.`);
  let brief = body;
  if (description !== undefined && description !== null) brief = `Task: ${description}\n\n${brief}`;
  if (Array.isArray(skills) && skills.length > 0)
    brief = `Required skills to open first: ${skills.join(", ")} (read ~/.agents/skills/<skill>/SKILL.md or .agents/skills/<skill>/SKILL.md before starting)\n\n${brief}`;
  return brief;
}

/** `--provider claude/opus-4-8[:high]` → provider `claude`, model `opus-4-8`, optional `thinking`; a bare id carries no model. */
export function splitProvider(value) {
  const slash = value.indexOf("/");
  if (slash === -1) return { provider: value, model: undefined };
  const provider = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon === -1) return { provider, model: rest };
  const model = rest.slice(0, colon);
  const thinking = rest.slice(colon + 1);
  return thinking === "" ? { provider, model: rest } : { provider, model, thinking };
}

/** The startup banner echoes the CLI's provider argument verbatim, once. */
export function renderRunBanner(tasks, provider) {
  return `factory: run ${tasks.join(" ")} (n=${tasks.length}) — provider ${provider}`;
}

// ---- the ledger, read locally (the plugin is the only writer — never this file) -----------------

/**
 * Reads the ledger's complete lines — through the shared reader
 * (ledger-read.mjs) under the driver's own policy: the plugin is the only
 * writer (ADR 0004) and validated each line when it appended it, so blank
 * lines are skipped and only unparseable JSON refuses. A missing ledger is
 * an empty one (the plugin has never run); anything else unreadable throws —
 * the driver refuses to guess.
 */
export function readDriverLedger(stateDir) {
  const ledgerPath = join(stateDir, "ledger.jsonl");
  const read = readLedgerEvents(ledgerPath);
  if (read.missing) return [];
  if (read.failed !== undefined) throw read.failed;
  if (read.corrupt !== undefined) throw new Error(`${ledgerPath} is not a readable ledger: ${read.corrupt}`);
  return read.events;
}

/** The task's Contract — the driver's pre-spawn source for the workspace. */
export function contractFromLedger(events, task) {
  let contract;
  for (const evt of events) {
    if (evt.event === "contract_set" && evt.task === task) contract = evt;
  }
  return contract;
}

/**
 * What the driver reports at a task's verdict: the last Attempt's number,
 * verdict and attested sha, the report path, the choke counts, acceptance.
 * All from the ledger the plugin wrote while the agent worked.
 */
export function taskOutcome(events, task) {
  const outcome = { attempt: 0, verdict: undefined, sha: undefined, reportPath: undefined, allowed: 0, denied: 0, blocked: 0, accepted: false };
  for (const evt of events) {
    if (evt.task !== task) continue;
    if (evt.event === "gate_finished") {
      outcome.attempt = evt.attempt;
      outcome.verdict = evt.verdict;
      outcome.sha = typeof evt.sha === "string" ? evt.sha : undefined;
    } else if (evt.event === "report_written") {
      outcome.reportPath = evt.path;
    } else if (evt.event === "permit_allowed") {
      outcome.allowed += 1;
    } else if (evt.event === "permit_denied") {
      outcome.denied += 1;
    } else if (evt.event === "git_blocked") {
      outcome.blocked += 1;
    } else if (evt.event === "attempt_accepted") {
      outcome.accepted = true;
    }
  }
  return outcome;
}

// ---- pre-spawn: local sanity + the branch (ticket 03 §2 — refusals here write no ledger line) ----

function gitIn(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
}

/**
 * The two local sanity checks plus the branch: the workspace must exist and
 * sit clean (`git status --porcelain` empty), then the driver switches to
 * the task's branch — creating it on first run, switching when it already
 * exists (the re-run case). The agent never creates branches; task ids are
 * branch-safe by the same pattern the core enforces.
 */
export function prepareWorkspace(workspace, task) {
  let info;
  try {
    info = statSync(workspace);
  } catch {
    return { ok: false, reason: `workspace "${workspace}" does not exist` };
  }
  if (!info.isDirectory()) {
    return { ok: false, reason: `workspace "${workspace}" is not a directory` };
  }
  const status = gitIn(workspace, ["status", "--porcelain"]);
  if (status.error !== undefined || status.status !== 0) {
    return { ok: false, reason: `git cannot read ${workspace}: ${firstLine(status.stderr ?? status.error?.message ?? "")}` };
  }
  const changes = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (changes.length > 0) {
    return { ok: false, reason: `workspace tree not clean (${changes.length} change${changes.length === 1 ? "" : "s"}): ${changes[0].trim()}` };
  }
  const branchExists = gitIn(workspace, ["show-ref", "--verify", "--quiet", `refs/heads/${task}`]).status === 0;
  const switched = branchExists ? gitIn(workspace, ["switch", task]) : gitIn(workspace, ["switch", "-c", task]);
  if (switched.error !== undefined || switched.status !== 0) {
    return { ok: false, reason: `could not ${branchExists ? "switch to" : "create"} branch ${task}: ${firstLine(switched.stderr ?? switched.error?.message ?? "")}` };
  }
  return { ok: true, branchExisted: branchExists };
}

/**
 * ADR 0008 §2: before creating a replacement agent on Respawn, clean
 * uncommitted worktree fragments (`git checkout -- . && git clean -fd`) in
 * the task's workspace while preserving committed branch state (`HEAD`).
 */
function cleanWorkspaceForRespawn(workspace) {
  if (typeof workspace !== "string" || workspace === "") return;
  gitIn(workspace, ["checkout", "--", "."]);
  gitIn(workspace, ["clean", "-fd"]);
}

function firstLine(text) {
  return typeof text === "string" && text.trim() !== "" ? text.trim().split("\n")[0] : "unknown git failure";
}

// ---- the daemon, over its own WebSocket (scout §a: hello + localCredential + session envelopes) ----

/**
 * Parses one WS text frame into its session message: `{type:"session",
 * message:{…}}` unwraps to the message; top-level frames (`hello.rejected`)
 * pass through with their envelope type attached. Undefined when the frame is
 * not JSON — the daemon never sends that, and ignoring beats crashing.
 */
function unwrap(event) {
  const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (envelope.type === "session") return envelope.message;
  return { ...envelope, envelopeType: envelope.type };
}

/**
 * A minimal daemon RPC client: connect (re-reading `paseo.pid` and the
 * credential each time), hello, then fire requests matched by requestId.
 * `features` carries what `server_info` advertised — the modern
 * `agent.create.request` rides on `creationLifecycle`, the legacy
 * `create_agent_request` otherwise.
 */
export class DaemonRpc {
  /** @param {string} home the paseo home carrying `paseo.pid` + `local-credential` */
  constructor(home) {
    this.home = home;
    this.ws = null;
    this.features = null;
    this.waiters = new Map();
    this.requestCounter = 0;
  }

  /** Connects and completes the hello handshake. Throws on failure — callers decide what a failed daemon means. */
  connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let listen;
      try {
        listen = JSON.parse(readFileSync(join(this.home, "paseo.pid"), "utf8")).listen;
      } catch (err) {
        reject(new Error(`cannot read the daemon address from ${join(this.home, "paseo.pid")}: ${err.message}`));
        return;
      }
      if (typeof listen !== "string" || listen === "") {
        reject(new Error(`${join(this.home, "paseo.pid")} carries no listen address`));
        return;
      }
      let token;
      try {
        token = readFileSync(join(this.home, "local-credential"), "utf8").trim();
      } catch (err) {
        reject(new Error(`cannot read ${join(this.home, "local-credential")}: ${err.message}`));
        return;
      }
      let ws;
      try {
        ws = new WebSocket(`ws://${listen}/ws`);
      } catch (err) {
        reject(new Error(`cannot open ws://${listen}/ws: ${err.message}`));
        return;
      }
      this.ws = ws;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("message", onHandshakeMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        if (err !== undefined) {
          try {
            ws.close();
          } catch {}
          reject(err);
        } else {
          // Past the handshake, inbound frames route to request waiters and
          // a socket death rejects them — reconnection is the poll loop's
          // business, not the socket's.
          ws.addEventListener("message", (event) => {
            const msg = unwrap(event);
            if (msg !== undefined) this.deliver(msg);
          });
          ws.addEventListener("close", () => this.rejectAllPending(new DaemonConnectionError("the daemon socket closed")));
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error(`daemon handshake timed out after ${timeoutMs}ms (ws://${listen}/ws)`)), timeoutMs);
      const onOpen = () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            clientId: `paseo-factory-driver-${randomUUID().slice(0, 8)}`,
            clientType: "cli",
            protocolVersion: 1,
            auth: { kind: "localCredential", token },
          }),
        );
      };
      const onHandshakeMessage = (event) => {
        const msg = unwrap(event);
        if (msg === undefined) return;
        if (msg.envelopeType === "hello.rejected") {
          finish(new Error(`daemon rejected the hello: ${JSON.stringify(msg.reason ?? "")}`));
          return;
        }
        if (msg.type === "status" && msg.payload?.status === "server_info") {
          this.features = msg.payload.features ?? {};
          finish();
          return;
        }
      };      const onClose = () => finish(new Error("the daemon socket closed before the handshake finished"));
      const onError = () => finish(new Error(`the daemon socket errored before the handshake finished (ws://${listen}/ws)`));
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onHandshakeMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  /** Routes one unwrapped session message to its waiter, if any. */
  deliver(msg) {
    if (msg.type === "rpc_error" && typeof msg.payload?.requestId === "string") {
      const waiter = this.waiters.get(msg.payload.requestId);
      if (waiter !== undefined) {
        this.waiters.delete(msg.payload.requestId);
        const err = new Error(msg.payload.error ?? "daemon rpc error");
        err.rpc = true;
        err.code = msg.payload.code;
        waiter.fn(err);
      }
      return;
    }
    const requestId = msg.payload?.requestId;
    if (typeof requestId !== "string") return;
    const waiter = this.waiters.get(requestId);
    if (waiter === undefined) return;
    if (msg.type !== waiter.responseType) return;
    this.waiters.delete(requestId);
    waiter.fn(undefined, msg.payload);
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends one RPC and resolves the response payload. Rejects with a
   * `.rpc` error for a daemon-side rpc_error, and with a
   * DaemonConnectionError when the socket gives out first.
   */
  request(message, { responseType, timeoutMs = 15_000 }) {
    if (!this.connected) return Promise.reject(new DaemonConnectionError("not connected"));
    const requestId = `factory-driver-${++this.requestCounter}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`no ${responseType} within ${timeoutMs}ms for ${message.type}`));
      }, timeoutMs);
      this.waiters.set(requestId, {
        responseType,
        fn: (err, payload) => {
          clearTimeout(timer);
          if (err !== undefined) reject(err);
          else resolve(payload);
        },
      });
      try {
        this.ws.send(JSON.stringify({ type: "session", message: { ...message, requestId } }));
      } catch (err) {
        this.waiters.delete(requestId);
        clearTimeout(timer);
        reject(new DaemonConnectionError(`send failed: ${err.message}`));
      }
    });
  }

  rejectAllPending(err) {
    for (const waiter of this.waiters.values()) waiter.fn(err, undefined);
    this.waiters.clear();
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.rejectAllPending(new DaemonConnectionError("the driver closed the connection"));
  }
}

export class DaemonConnectionError extends Error {}

/** Reconnect with re-read pid + credential — both change across a daemon restart (scout caveat). */
async function reconnect(rpc, log) {
  for (;;) {
    try {
      await rpc.connect();
      return;
    } catch (err) {
      log(`factory: daemon unreachable (${err.message}) — retrying in 5s`);
      await sleep(5_000);
    }
  }
}

/**
 * Creates the task's agent over the daemon RPC. `idempotencyKey` = the task
 * id (ticket 03 §3): a crash-safe re-run meets the same operation — same
 * intent returns the existing agent, a different intent surfaces a
 * structured `agent_request_key_conflict`, never a silent second agent.
 * `title` = the task id; the brief is the runbook template with the PATH
 * baked from this process's environment, and the contract's description
 * (when set) riding ahead of it as the assignment.
 */
export async function createTaskAgent(rpc, { task, idempotencyKey, provider, model, thinking, cwd, brief, parent, leadAgentId, workspaceId, projectSlug, project }) {
  const config = {
    provider,
    cwd,
    title: task,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinkingOptionId: thinking }),
  };
  const resolvedParent = parent ?? leadAgentId;
  const resolvedProject = projectSlug ?? project;
  const labels = {
    seat: "agent",
    ...(typeof resolvedProject === "string" && resolvedProject !== "" ? { project: resolvedProject } : {}),
    task,
  };
  const extra = {
    labels,
    ...(typeof resolvedParent === "string" && resolvedParent !== "" ? { parent: resolvedParent, callerAgentId: resolvedParent } : {}),
    ...(typeof workspaceId === "string" && workspaceId !== "" ? { workspaceId } : {}),
  };
  if (rpc.features?.creationLifecycle === true) {
    const payload = await rpc.request(
      { type: "agent.create.request", idempotencyKey: idempotencyKey ?? task, subscribe: true, config, initialPrompt: brief, ...extra },
      { responseType: "agent.create.response", timeoutMs: CREATE_TIMEOUT_MS },
    );
    if (payload.error !== undefined && payload.error !== null) {
      const err = new Error(payload.error);
      err.code = payload.errorCode;
      throw err;
    }
    if (payload.agent?.id === undefined) throw new Error("agent creation returned no agent");
    return payload.agent.id;
  }
  // Legacy host: the keyed create cannot carry a prompt (COMPAT
  // creationLifecycle), so this path is unkeyed — re-run protection rests on
  // the operator's eyes. The trial daemon (0.10.3) advertises the feature.
  const payload = await rpc.request(
    { type: "create_agent_request", config, initialPrompt: brief, ...extra },
    { responseType: "status", timeoutMs: CREATE_TIMEOUT_MS },
  );
  if (payload.status === "agent_create_failed") throw new Error(payload.error ?? "agent creation failed");
  if (payload.agent?.id === undefined) throw new Error("agent creation returned no agent");
  return payload.agent.id;
}

async function archiveTaskAgentBestEffort(rpc, agentId) {
  if (typeof agentId !== "string" || agentId === "") return;
  try {
    await rpc.request({ type: "archive_agent_request", agentId }, { responseType: "agent_archived", timeoutMs: 5_000 });
  } catch {
    // best-effort archive
  }
}

// ---- the Lead rider (v0.0.10, ADR 0006 §3): the denial-stall predicate, the one re-poke, the named end ----

/**
 * Events the Lead's predicate ignores when it walks a task's slice for its
 * last event (the v0.0.10 design §1 / ADR 0008): the driver's own meter line
 * and the Lead's own re-poke, respawn, and needs-human lines are not agent
 * activity, so none of them can displace a denial from last position.
 */
const PREDICATE_IGNORED = new Set([
  "meter_written",
  "repoke_dispatched",
  "repoke_refused",
  "respawn_dispatched",
  "respawn_refused",
  "needs_human",
]);

/**
 * The re-poke's fixed text (the v0.0.10 design §2) — the needed-text shape
 * of the canonical report-missing notices, adapted to name the denial. Only
 * the task and the denial's rule interpolate; no model calls, and nothing
 * here grants a permission or widens a scope.
 */
export function repokeText(task, rule) {
  return `Your permit ask for task ${task} was denied (rule ${rule}). The turn ended without a Claim. Continue by a route that needs no denied permission and make your Claim — or end your turn stating what you need from the Owner.`;
}

/**
 * The Lead's one decision over a task's ledger slice (the v0.0.10 design
 * §1 + §3 / ADR 0008 §1), evaluated at every poll in both watch branches. Pure
 * ledger arithmetic — the measured surface (the daemon stream never reached the
 * driver in any stall; the ledger is the one carrier of the denial and the
 * gate verdict):
 *
 * - `poke` — the last task event (predicate-ignored kinds aside) is a
 *   `permit_denied`, the grace is spent, and no `repoke_dispatched` exists:
 *   spend the task's one re-poke now. `denial` is the event to answer.
 * - `needs-human` — the task's latest `gate_finished` is `red` at
 *   `attempt >= MAX_ATTEMPTS` (`attempt-ceiling`), OR the poke is spent and the
 *   stall persisted: a NEW denial after the poke's seq (`denied-again`), or no
 *   task event at all after it for `RE_STALL_MS` (`silent-after-repoke`).
 *   Terminal for the watch.
 * - `watch` — a Lead condition is still pending (grace not spent, or the
 *   re-stall window still open): hold any `finished` commit — a ledger
 *   stall must not end in the classifier's silent swallow.
 * - `clear` — no Lead condition: ordinary classification may proceed.
 *
 * True negatives by construction: an absorbed denial is displaced from last
 * position by the agent's later events; spawn-then-silence never shows a
 * denial in last position (visible-but-unactionable, the later row's lane);
 * post-claim denials fail the last-position test.
 */
export function leadDecision(events, task, now = Date.now(), { graceMs = GRACE_MS, reStallMs = RE_STALL_MS } = {}) {
  let repoke;
  let lastGate;
  const relevant = [];
  for (const evt of events) {
    if (evt.task !== task) continue;
    if (evt.event === "repoke_dispatched") repoke = evt;
    if (evt.event === "gate_finished") lastGate = evt;
    if (PREDICATE_IGNORED.has(evt.event)) continue;
    relevant.push(evt);
  }
  if (lastGate !== undefined && lastGate.verdict === "red" && lastGate.attempt >= MAX_ATTEMPTS) {
    return { act: "needs-human", reason: "attempt-ceiling", evidence: { attempt: lastGate.attempt, gate: lastGate.seq } };
  }
  const last = relevant.at(-1);
  if (last !== undefined && last.event === "permit_denied") {
    if (now - Date.parse(last.ts) < graceMs) return { act: "watch", why: "denial grace" };
    if (repoke === undefined) return { act: "poke", denial: last };
    if (repoke.seq < last.seq) {
      // A new denial after the spend — nothing relevant after it (last
      // position), and the grace above already elapsed on THIS denial.
      return { act: "needs-human", reason: "denied-again", evidence: { denial: last.seq, repoke: repoke.seq } };
    }
    if (now - Date.parse(repoke.ts) > reStallMs) {
      return { act: "needs-human", reason: "silent-after-repoke", evidence: { denial: last.seq, repoke: repoke.seq } };
    }
    return { act: "watch", why: "re-stall window" };
  }
  if (repoke !== undefined) {
    const quietSincePoke = !relevant.some((e) => e.seq > repoke.seq);
    if (quietSincePoke) {
      if (now - Date.parse(repoke.ts) > reStallMs) {
        // The poke's own denial is the evidence's denial — the stall it answered.
        const denial = relevant.findLast((e) => e.event === "permit_denied" && e.seq < repoke.seq);
        if (denial !== undefined) {
          return { act: "needs-human", reason: "silent-after-repoke", evidence: { denial: denial.seq, repoke: repoke.seq } };
        }
      }
      return { act: "watch", why: "re-stall window" };
    }
    // Activity after the poke — the Lead's answer arrived (a claim, an ask,
    // anything): its window is closed, ordinary classification proceeds.
  }
  return { act: "clear" };
}

/**
 * This task's latest `spawn_dispatched` or `respawn_dispatched` seq — the
 * anchor for both this-run windows (`postSpawnLife` and `verdictOfThisRun`;
 * -1 when never spawned). After a Respawn, the replacement agent's run
 * anchors at its own `respawn_dispatched` line (ADR 0008 §2).
 */
function lastSpawnSeq(events, task) {
  let seq = -1;
  for (const evt of events) {
    if (evt.task === task && (evt.event === "spawn_dispatched" || evt.event === "respawn_dispatched")) seq = evt.seq;
  }
  return seq;
}

/**
 * Post-spawn evidence of life — demoted to defense-in-depth by ADR 0007 §4:
 * any task event after THIS run's `spawn_dispatched` that is not the
 * driver's or the Lead's own writing — an ask, a denial, a claim. Death no
 * longer reads it (the timeline oracle owns that); it survives at exactly
 * one place: a timeline not-found contradicted by ledger life is a state
 * the watch survives on the ledger predicate, not a death. `spawn_refused`
 * is excluded alongside: a refused re-invocation is the operator's act, not
 * agent life.
 */
export function postSpawnLife(events, task) {
  const spawnSeq = lastSpawnSeq(events, task);
  if (spawnSeq === -1) return false;
  for (const evt of events) {
    if (evt.task !== task || evt.seq <= spawnSeq) continue;
    if (evt.event === "spawn_dispatched" || evt.event === "spawn_refused" || PREDICATE_IGNORED.has(evt.event)) continue;
    return true;
  }
  return false;
}

/**
 * This run's verdict, if the ledger already holds one: a `gate_finished`
 * after the task's latest `spawn_dispatched`. The null-fetch lane's finish
 * signal — on this daemon the snapshot lane is dead from tick one, so the
 * verdict the run exists to print is read from the ledger the plugin wrote
 * while the agent worked.
 */
export function verdictOfThisRun(events, task) {
  const spawnSeq = lastSpawnSeq(events, task);
  let verdict;
  for (const evt of events) {
    if (evt.task === task && evt.event === "gate_finished" && evt.seq > spawnSeq) verdict = evt;
  }
  return verdict;
}

/**
 * The Lead's one spend: one `repoke` request through the spool (the plugin
 * holds the one-per-task law and appends the line — dispatched or refused),
 * and only on ok the fixed message over the daemon's own session socket.
 * The send targets an agent the ledger shows stalled — idle, nothing
 * pending, its denial-ended turn seconds gone — so the send's
 * interrupt/clear-pending defaults are moot, and delivery truth stays the
 * timeline's message-id only: ambiguity is uncertainty, and the
 * claim-or-restall outcome is the observable (no delivery event in v1). The
 * deterministic `messageId` rides the daemon's own send receipts, so a
 * replayed send cannot double-deliver. Report-only in every failure shape —
 * a refusal, a silent plugin or an unaccepted send is logged and the watch
 * continues on the ledger; the spend stands as the ledger wrote it.
 */
async function spendRepoke(rpc, spoolRoot, entry, denial, log) {
  // One ask per process even when the plugin never answers — the request
  // stays in the spool and may still be processed; the slice is the truth.
  entry.repokeSubmitted = true;
  const request = { id: randomId(), kind: "repoke", task: entry.task, agent: entry.agentId };
  submit(spoolRoot, request);
  const reply = await awaitReply(spoolRoot, request.id, LEAD_WAIT_MS);
  if (reply === null) {
    log(`factory: ${entry.task} re-poke — no reply within ${LEAD_WAIT_MS / 1000}s (request ${request.id} stays in the spool; the ledger decides the spend)`);
    return;
  }
  if (!reply.ok) {
    log(`factory: ${entry.task} re-poke refused — ${reply.code}: ${reply.message}`);
    return;
  }
  log(`factory: ${entry.task} re-poke dispatched — the task's one spend, answering the denial at seq ${denial.seq}`);
  try {
    const sent = await rpc.request(
      { type: "send_agent_message_request", agentId: entry.agentId, text: repokeText(entry.task, denial.rule), messageId: `factory-repoke-${entry.task}` },
      { responseType: "send_agent_message_response", timeoutMs: SEND_WAIT_MS },
    );
    if (sent.accepted === true) {
      log(`factory: ${entry.task} re-poke sent — the claim-or-restall outcome is the observable`);
    } else {
      log(`factory: ${entry.task} re-poke send not accepted — ${sent.error ?? "no reason given"} (the spend stands; the outcome stays observable)`);
    }
  } catch (err) {
    log(`factory: ${entry.task} re-poke send failed — ${err.message} (the spend stands; the outcome stays observable)`);
  }
}

/**
 * The stall's named end: one `needs_human` request through the spool (the
 * plugin validates the spend and appends the line with its evidence seqs),
 * then the task's terminal fate — `verdict=-`, the reason printed, the
 * meter captured as at any terminal. A refused or unanswered submission is
 * logged and the terminal stands: the stall is a fact the driver measured,
 * and the missing line is visible in this log, never silently dropped.
 * Returns the fate to commit; the caller owns the commit.
 */
async function endNeedsHuman(spoolRoot, task, signal, log) {
  const request = { id: randomId(), kind: "needs_human", task, reason: signal.reason, evidence: signal.evidence };
  submit(spoolRoot, request);
  const reply = await awaitReply(spoolRoot, request.id, LEAD_WAIT_MS);
  if (reply === null) {
    log(`factory: ${task} needs-human — no reply within ${LEAD_WAIT_MS / 1000}s (request ${request.id} stays in the spool; no ledger line yet)`);
  } else if (!reply.ok) {
    log(`factory: ${task} needs-human refused — ${reply.code}: ${reply.message} (no ledger line)`);
  }
  const detail =
    "denial" in signal.evidence
      ? `denial seq ${signal.evidence.denial}, repoke seq ${signal.evidence.repoke}`
      : "attempt" in signal.evidence
        ? `attempt ${signal.evidence.attempt}, gate seq ${signal.evidence.gate}`
        : `spawn seq ${signal.evidence.spawn}, respawn seq ${signal.evidence.respawn}`;
  return { fate: "needs-human", reason: `${signal.reason} (${detail})` };
}

// ---- observe: poll snapshots to a terminal state, stall report-only (ticket 03 §5–6) -----------------

/**
 * A snapshot's verdict on the agent's run: finished (its turn is done — the
 * task's verdict now lives in the ledger), died (status error), closed, or
 * still going. `idle` with the prompt consumed and nothing pending counts as
 * finished even when the attention flag was cleared by another watcher.
 */
export function agentFate(agent) {
  if (agent.status === "error") {
    return { terminal: true, fate: "died", reason: typeof agent.lastError === "string" && agent.lastError !== "" ? agent.lastError : "agent status is error" };
  }
  if (agent.status === "closed") {
    return { terminal: true, fate: "closed", reason: "the agent was closed" };
  }
  const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions.length : 0;
  if (agent.status === "idle" && (agent.attentionReason === "finished" || (agent.lastUserMessageAt !== null && agent.lastUserMessageAt !== undefined && pending === 0))) {
    return { terminal: true, fate: "finished" };
  }
  return { terminal: false };
}

/**
 * The observe loop: poll `fetch_agent` for every unfinished agent every
 * `pollMs`, reconnecting (with re-read pid + credential) whenever the socket
 * gives out — post-restart finish-vs-die comes from the daemon's persisted
 * record, which `fetch_agent` serves just as well. Only a daemon *answer*
 * (`rpc_error`, an agent that is gone) ends a task as died; a transport
 * hiccup or a slow poll is transient and simply tries again next tick —
 * "restart-tolerant, keep polling" must not misreport a live agent. No
 * overall timeout: the run ends when every agent is terminal or the operator
 * interrupts. `onTerminal` fires once per task, the moment it lands — it may
 * be async (the driver's callback submits the meter there), and the loop
 * awaits it: a meter submission must finish before the run's exit judgement,
 * never race it. At each terminal moment the daemon's usage snapshot is
 * captured onto the entry (`entry.usage`, the v0.0.8 meter's input) — the
 * one re-fetch riding along below.
 *
 * Since v0.0.10 the loop carries the Lead rider in both of its branches
 * (the design §1's two insertions): the null lane routes through the death
 * oracle before its ledger predicate runs, and a `finished` classification
 * is intercepted when the ledger shows a stall the Lead still owes an
 * answer (poke, needs-human, or a pending window). Since v0.0.11 (ADR 0007)
 * the null lane's first act is the timeline read: the fast door (its
 * not-found answer, defended by post-spawn ledger life) and the slow door
 * (no `seqEnd` growth for the bound) are the only deaths; every surviving
 * tick
 * continues on the ledger predicate — the Lead rider and the verdict
 * finish, the v0.0.10 witnessed shape. `stateDir` and `spoolRoot` are the
 * rider's surfaces: the ledger is the predicate's only input, and both Lead
 * acts are spool submissions.
 */
export async function observeTasks(
  rpc,
  entries,
  { pollMs = POLL_MS, log = () => {}, onTerminal = () => {}, stateDir, spoolRoot, provider, missingDeadMs = ZERO_GROWTH_DEAD_MS, graceMs = GRACE_MS, reStallMs = RE_STALL_MS } = {},
) {
  const commitTerminal = async (entry, fate, snapshot) => {
    entry.terminal = fate;
    await captureUsage(rpc, entry, snapshot);
    await onTerminal(entry);
    await archiveTaskAgentBestEffort(rpc, entry.agentId);
  };
  /**
   * The Lead's one cascade, shared by both watch branches (design §1's two
   * insertions — only the finish signal differs, and that is the caller's):
   * "hold" = a Lead window or the poke's outcome is pending — no finish may
   * commit; "terminal" = the named end committed here; "clear" = no Lead
   * condition, the caller's ordinary classification proceeds.
   */
  const runLead = async (entry, events, snapshot) => {
    const lead = leadDecision(events, entry.task, Date.now(), { graceMs, reStallMs });
    if (lead.act === "poke") {
      if (entry.repokeSubmitted !== true) await spendRepoke(rpc, spoolRoot, entry, lead.denial, log);
      return "hold";
    }
    if (lead.act === "needs-human") {
      const fate = await endNeedsHuman(spoolRoot, entry.task, lead, log);
      await commitTerminal(entry, fate, snapshot);
      return "terminal";
    }
    return lead.act === "watch" ? "hold" : "clear";
  };
  /**
   * The null lane's ledger continuation — v0.0.10's witnessed shape, kept
   * whole (ADR 0007 §4), with the ADR 0008 §1 multi-attempt survival rule:
   * `runLead` runs first (catching `attempt-ceiling` at Attempt 3 red), and
   * on `"clear"` only a `green` `gate_finished` ends the watch as `finished`
   * — a `red` Attempt < `MAX_ATTEMPTS` stays in the loop so the agent can
   * make its next Attempt.
   */
  const continueOnLedger = async (entry, events) => {
    const outcome = await runLead(entry, events, undefined);
    if (outcome !== "clear") return;
    const verdict = verdictOfThisRun(events, entry.task);
    if (verdict !== undefined && verdict.verdict === "green") {
      log(`factory: ${entry.task} verdict on the ledger (the snapshot lane stayed null) — attempt ${verdict.attempt} ${verdict.verdict}`);
      await commitTerminal(entry, { fate: "finished" }, undefined);
    }
  };
  /**
   * ADR 0008 §2: on `Substrate death` (either watch lane), when `provider` is
   * present, check the task's ledger slice for the one-Respawn-per-progress-marker
   * law. Meter the dead agent first, then either dispatch the replacement
   * agent (cleaning uncommitted worktree fragments and keying create by
   * `${task}-respawn-${event.seq}`) or end the task in
   * `needs_human ("died-after-respawn")` when a Respawn was already spent.
   */
  const handleSubstrateDeath = async (entry, reason, snapshot) => {
    if (typeof provider !== "string" || provider.trim() === "") {
      if (snapshot === undefined) {
        entry.terminal = { fate: "died", reason };
        await onTerminal(entry);
      } else {
        await commitTerminal(entry, { terminal: true, fate: "died", reason }, snapshot);
      }
      return;
    }
    const events = readDriverLedger(stateDir);
    let lastSpawn;
    let lastGate;
    let lastRespawn;
    let maxAttempt = 0;
    let hasGreen = false;
    for (const evt of events) {
      if (evt.task !== entry.task) continue;
      if (Number.isInteger(evt.attempt) && evt.attempt > maxAttempt) maxAttempt = evt.attempt;
      if (evt.event === "spawn_dispatched") lastSpawn = evt;
      else if (evt.event === "gate_finished") {
        lastGate = evt;
        if (evt.verdict === "green") hasGreen = true;
      } else if (evt.event === "respawn_dispatched") {
        lastRespawn = evt;
      }
    }
    const progressSeq = Math.max(lastSpawn?.seq ?? -1, lastGate?.seq ?? -1);
    const spentRespawn = lastRespawn !== undefined && lastRespawn.seq > progressSeq ? lastRespawn : undefined;

    // Always capture and submit the dead agent's meter before replacing or ending.
    await captureUsage(rpc, entry, snapshot);
    await submitMeter(spoolRoot, entry, provider, log);
    entry.metered = true;

    if (spentRespawn !== undefined && lastSpawn !== undefined) {
      const nhFate = await endNeedsHuman(
        spoolRoot,
        entry.task,
        { reason: "died-after-respawn", evidence: { spawn: lastSpawn.seq, respawn: spentRespawn.seq } },
        log,
      );
      entry.terminal = nhFate;
      await onTerminal(entry);
      await archiveTaskAgentBestEffort(rpc, entry.agentId);
      return;
    }

    if (spentRespawn === undefined && lastSpawn !== undefined && !hasGreen && maxAttempt < MAX_ATTEMPTS) {
      const diedAgentId = entry.agentId;
      const request = { id: randomId(), kind: "respawn", task: entry.task, provider, died_agent: diedAgentId };
      submit(spoolRoot, request);
      const reply = await awaitReply(spoolRoot, request.id, LEAD_WAIT_MS);
      if (reply === null) {
        log(`factory: ${entry.task} respawn — no reply within ${LEAD_WAIT_MS / 1000}s (request ${request.id} stays in the spool)`);
      } else if (!reply.ok) {
        log(`factory: ${entry.task} respawn refused — ${reply.code}: ${reply.message}`);
      } else {
        await archiveTaskAgentBestEffort(rpc, diedAgentId);
        const contract = contractFromLedger(events, entry.task);
        const workspace = entry.workspace ?? contract?.workspace;
        cleanWorkspaceForRespawn(workspace); // the TASK WORKTREE on the worktree path — never <project-root>
        const brief = entry.brief ?? renderBrief(entry.task, process.env.PATH ?? "", contract?.description, contract?.skills, entry.branch);
        const { provider: providerId, model, thinking } = splitProvider(provider);
        const respawnSeq = reply.event?.seq;
        const idempotencyKey = respawnSeq !== undefined ? `${entry.task}-respawn-${respawnSeq}` : `${entry.task}-respawn`;
        const leadAgentId = reply.leadAgentId ?? entry.leadAgentId;
        const workspaceId = reply.workspaceId ?? entry.workspaceId;
        const projectSlug = reply.projectSlug ?? entry.projectSlug;
        try {
          const newAgentId = await createTaskAgent(rpc, {
            task: entry.task,
            idempotencyKey,
            provider: providerId,
            ...(model === undefined ? {} : { model }),
            ...(thinking === undefined ? {} : { thinking }),
            cwd: workspace,
            brief,
            ...(leadAgentId === undefined ? {} : { parent: leadAgentId }),
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(projectSlug === undefined ? {} : { projectSlug }),
          });
          entry.agentId = newAgentId;
          if (leadAgentId !== undefined) entry.leadAgentId = leadAgentId;
          if (workspaceId !== undefined) entry.workspaceId = workspaceId;
          if (projectSlug !== undefined) entry.projectSlug = projectSlug;
          resetWatchTrackers(entry);
          log(`factory: ${entry.task} agent ${newAgentId.slice(0, 12)} respawned (replacing ${diedAgentId.slice(0, 12)}) — watching to verdict`);
          return;
        } catch (err) {
          log(`factory: ${entry.task} respawn agent create failed — ${err.code !== undefined ? `${err.code}: ` : ""}${err.message}`);
        }
      }
    }

    entry.terminal = { fate: "died", reason };
    await onTerminal(entry);
    await archiveTaskAgentBestEffort(rpc, entry.agentId);
  };
  const resetWatchTrackers = (entry) => {
    entry.printedStatus = undefined;
    entry.timelineSeq = -1;
    entry.timelineStillSince = Date.now();
    entry.warned = false;
    entry.missingSince = undefined;
    entry.metered = false;
  };
  for (const entry of entries) {
    entry.terminal = undefined;
    entry.repokeSubmitted = undefined;
    resetWatchTrackers(entry);
  }
  while (entries.some((e) => e.terminal === undefined)) {
    for (const entry of entries) {
      if (entry.terminal !== undefined) continue;
      let snapshot;
      try {
        if (!rpc.connected) await reconnect(rpc, log);
        const payload = await rpc.request({ type: "fetch_agent_request", agentId: entry.agentId }, { responseType: "fetch_agent_response" });
        if (payload.error !== undefined && payload.error !== null) throw rpcError(payload.error);
        if (payload.agent === null || payload.agent === undefined) {
          // Daemon 0.11 answers a single-agent fetch with null for a closed
          // agent, an idle one, and a never-existed UUID alike — the null is
          // an empty signal (ADR 0007's probe), so before any death
          // arithmetic the lane reads the timeline: the death oracle. The
          // agents-list RPC that would disambiguate is not answered on the
          // session socket (verified live: silently dropped).
          const events = readDriverLedger(stateDir);
          let timeline;
          try {
            timeline = await fetchTimeline(rpc, entry);
          } catch (err) {
            if (err.rpc === true && /not found/i.test(err.message)) {
              // The oracle's one death answer — arriving live as the resolved
              // `error` payload `fetchTimeline` folds into this thrown shape
              // (ADR 0007 §2's 2026-10-14 correction) — defended first (§4):
              // a not-found contradicted by post-spawn ledger life is a state
              // the watch survives on the ledger predicate, not a death.
              if (postSpawnLife(events, entry.task)) {
                entry.missingSince = undefined;
                await continueOnLedger(entry, events);
                continue;
              }
              throw rpcError(`${err.message} — substrate death (the fast door: the timeline's own answer)`);
            }
            // Transport trouble, or a daemon answer that is not the
            // not-found shape — never a death this tick. The death question
            // waits for a real answer; the finish signal does not: the
            // ledger continuation runs whatever the timeline said.
            log(`factory: ${entry.task} timeline read failed (${err.message}) — retrying next poll`);
            await continueOnLedger(entry, events);
            continue;
          }
          // The timeline answers: the agent exists, and its growth is the
          // life signal. The shared fold keeps the tracker whole across a
          // flapping snapshot lane.
          const seq = maxSeqEnd(timeline, entry.timelineSeq);
          const grew = seq !== entry.timelineSeq;
          if (grew) {
            entry.timelineSeq = seq;
            entry.missingSince = undefined;
          }
          await continueOnLedger(entry, events);
          if (entry.terminal !== undefined) continue;
          if (!grew) {
            const now = Date.now();
            if (entry.missingSince === undefined) {
              entry.missingSince = now;
            } else if (now - entry.missingSince > missingDeadMs) {
              // The slow door: an existing agent whose life signal went
              // silent for the bound — death, called honestly, meter
              // included (the rider above may already have ended the task,
              // which is what the terminal check protects).
              throw rpcError(`no timeline growth for ${Math.round((now - entry.missingSince) / 1000)}s — substrate death (the slow door)`);
            }
          }
          continue;
        }
        snapshot = payload.agent;
      } catch (err) {
        if (err.rpc === true) {
          // The daemon answered and the answer is death: the snapshot lane's
          // own error answer, or one of the null lane's two doors thrown
          // above. Route through the ADR 0008 §2 Respawn rider.
          await handleSubstrateDeath(entry, err.message, undefined);
          continue;
        }
        // Connection trouble or a slow poll — transient, never a verdict.
        // The next tick retries; a daemon that never comes back is the
        // operator's interrupt, not a row of dead agents.
        log(`factory: ${entry.task} snapshot failed (${err.message}) — retrying next poll`);
        continue;
      }
      const fate = agentFate(snapshot);
      if (snapshot.status !== entry.printedStatus) {
        entry.printedStatus = snapshot.status;
        log(`factory: ${entry.task} agent ${snapshot.status}${snapshot.attentionReason === undefined ? "" : ` (${snapshot.attentionReason})`}`);
      }
      if (fate.terminal) {
        if (fate.fate === "died") {
          await handleSubstrateDeath(entry, fate.reason, snapshot);
          continue;
        }
        if (fate.fate === "finished") {
          // The Lead's second insertion (v0.0.10 §1): idle-without-Claim is
          // only a finish when the ledger agrees — a denial-stall matching
          // this classifier's own shape must not end in its silent swallow.
          const outcome = await runLead(entry, readDriverLedger(stateDir), snapshot);
          if (outcome !== "clear") continue; // the poke's outcome is pending, or the named end already committed
        }
        await commitTerminal(entry, fate, snapshot);
        continue;
      }
      await stallWatch(rpc, entry, snapshot, log).catch(() => {}); // a failed timeline read must not sink the poll
    }
    if (entries.some((e) => e.terminal === undefined)) await sleep(pollMs);
  }
}

function rpcError(message) {
  const err = new Error(message);
  err.rpc = true;
  return err;
}

/**
 * The timeline read both watch lanes share (ADR 0007): the tail of the
 * agent's daemon record — the death oracle in the null lane, the stall
 * meter's input in the snapshot lane. The shape `stallWatch` has always
 * sent: tail, five entries. The daemon (0.11) resolves the timeline's
 * failure as an `error` field on the response, not an rpc_error envelope —
 * witnessed live by the v0.0.11 judged run (ticket 03's central finding) —
 * so the field folds into the thrown shape here, the snapshot lane's own
 * `payload.error` pattern: the oracle's decision tree above discriminates
 * one answer either way, and an error payload is never misread as
 * "no entries → no growth".
 */
async function fetchTimeline(rpc, entry) {
  const payload = await rpc.request(
    { type: "fetch_agent_timeline_request", agentId: entry.agentId, direction: "tail", limit: 5 },
    { responseType: "fetch_agent_timeline_response" },
  );
  if (payload.error !== undefined && payload.error !== null) throw rpcError(payload.error);
  return payload;
}

/**
 * The fold over a timeline payload: the highest `seqEnd` it shows above the
 * floor — the life-signal tracker's one step, shared by both lanes so a
 * flapping snapshot lane cannot split the record.
 */
function maxSeqEnd(payload, floor) {
  let seq = floor;
  for (const item of Array.isArray(payload.entries) ? payload.entries : []) {
    if (typeof item.seqEnd === "number" && item.seqEnd > seq) seq = item.seqEnd;
  }
  return seq;
}

/**
 * Stall is a judgment the daemon does not make (scout §c): status `running`
 * with a timeline that has not grown, or an ask parked past the threshold.
 * Report-only — the driver never kills an agent; the warning prints once.
 */
async function stallWatch(rpc, entry, snapshot, log) {
  const now = Date.now();
  const pending = Array.isArray(snapshot.pendingPermissions) ? snapshot.pendingPermissions.length : 0;
  if (pending > 0) {
    if (!entry.warned && now - entry.timelineStillSince >= STALL_WARN_MS) {
      entry.warned = true;
      log(`factory: ${entry.task} stall warning: parked on a permission ask for ${Math.round((now - entry.timelineStillSince) / 1000)}s — still waiting (report-only)`);
    }
    return;
  }
  if (snapshot.status !== "running") {
    entry.timelineStillSince = now;
    return;
  }
  const payload = await fetchTimeline(rpc, entry);
  const seq = maxSeqEnd(payload, entry.timelineSeq);
  if (seq !== entry.timelineSeq) {
    entry.timelineSeq = seq;
    entry.timelineStillSince = now;
    entry.missingSince = undefined; // growth is the life signal wherever it is observed — the slow door's clock restarts with it
    return;
  }
  if (!entry.warned && now - entry.timelineStillSince >= STALL_WARN_MS) {
    entry.warned = true;
    log(`factory: ${entry.task} stall warning: running with no timeline growth for ${Math.round((now - entry.timelineStillSince) / 1000)}s — still waiting (report-only)`);
  }
}

// ---- meter: the terminal usage capture (v0.0.8, ticket 03 item 1) ----------------------

/** The meter's four usage fields — the daemon's own camelCase names, verbatim. */
const USAGE_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd"];

/**
 * The daemon's `lastUsage` reduced to the meter's fields: each present only
 * when the snapshot carried a finite number for it. An empty object is the
 * honest "capture ran, the lane reported nothing" — copilot dollars never
 * exist (ACP has no cost field), and a claude lane may report tokens without
 * a USD estimate. Nothing poses as zero.
 */
export function usageOf(lastUsage) {
  if (typeof lastUsage !== "object" || lastUsage === null) return {};
  const usage = {};
  for (const field of USAGE_FIELDS) {
    const value = lastUsage[field];
    if (typeof value === "number" && Number.isFinite(value)) usage[field] = value;
  }
  return usage;
}

/**
 * The terminal capture's race rule (ticket 03 item 1's build detail): the
 * daemon merges usage cumulatively (`{...lastUsage, ...event.usage}`), so a
 * re-fetch taken after the final merge carries the same fields with grown
 * values, or more fields. The later snapshot wins whenever it is not
 * emptier — same-field growth IS the race this exists to catch; only a
 * re-fetch that came back emptier (a `usage_updated` replace anomaly, or a
 * dead agent's null) leaves the terminal snapshot standing.
 */
export function pickUsage(terminal, refetched) {
  const refetchedSize = Object.keys(refetched).length;
  if (refetchedSize === 0 || refetchedSize < Object.keys(terminal).length) return terminal;
  return refetched;
}

/**
 * The terminal capture: `entry.usage` from the terminal snapshot, then ONE
 * re-fetch against the usage-merge race — the terminal poll can land in the
 * window between the status flipping and the last `turn_completed` folding
 * into `lastUsage`. Usage is live-only truth the daemon persists nowhere,
 * and this is the last chance to take it.
 */
async function captureUsage(rpc, entry, snapshot) {
  entry.usage = usageOf(snapshot?.lastUsage);
  try {
    const payload = await rpc.request({ type: "fetch_agent_request", agentId: entry.agentId }, { responseType: "fetch_agent_response" });
    if (payload.agent !== null && payload.agent !== undefined) {
      entry.usage = pickUsage(entry.usage, usageOf(payload.agent.lastUsage));
    }
  } catch {
    // The agent is gone or the socket blinked — the terminal snapshot stands.
  }
}

/** How long the meter's spool reply may take — the plugin answers it without running anything. */
const METER_WAIT_MS = 15_000;

/**
 * One task's meter submission: the captured usage rides a `meter` request
 * through the spool (ADR 0004 — the driver never writes the ledger; the
 * plugin validates and appends). Report-only in both failure shapes: a
 * refusal names its code, a silent plugin names the stuck request id, and
 * neither turns a green run red — the meter records, it never judges.
 */
async function submitMeter(spoolRoot, entry, provider, log) {
  const request = {
    id: randomId(),
    kind: "meter",
    task: entry.task,
    provider,
    usage: entry.usage ?? {},
    agent: entry.agentId,
  };
  submit(spoolRoot, request);
  const reply = await awaitReply(spoolRoot, request.id, METER_WAIT_MS);
  if (reply === null) {
    log(`factory: ${entry.task} meter — no reply within ${METER_WAIT_MS / 1000}s (request ${request.id} stays in the spool; no meter line)`);
    return;
  }
  if (!reply.ok) {
    log(`factory: ${entry.task} meter refused — ${reply.code}: ${reply.message} (no meter line)`);
    return;
  }
  log(`factory: ${entry.task} meter written — ${reply.summary}`);
}

// ---- the command -----------------------------------------------------------------------------------------------------

/**
 * `factory run` end to end: per task — local sanity + branch (exit-2
 * refusals, no spool request, no ledger line), the spool's `spawn` request
 * (the plugin appends `spawn_dispatched`/`spawn_refused`), then the agent
 * created over the daemon RPC, staggered. Then one observe loop to everyone's
 * terminal state, verdicts read from the ledger. At each task's terminal
 * moment the driver also meters it (v0.0.8): the daemon's usage snapshot,
 * captured off the terminal poll and submitted through the spool as one
 * `meter` request — the plugin validates and appends `meter_written`; a
 * refusal or a silent plugin is reported and the run moves on, because the
 * meter is a recorder and never re-judges a green run. Exit 0 iff every task
 * ended green and nothing was refused or failed along the way; else exit 2.
 */
export async function runDriver({ home, stateDir, spoolRoot, tasks, provider, waitSecs = 60, pollMs = POLL_MS, staggerMs = STAGGER_MS, log = (m) => console.log(m) }) {
  // These change spawn routing when the driver itself runs under an agent —
  // the driver spawns as itself, never as somebody's child (scout §a caveat).
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_WORKSPACE_ID;

  const say = log;
  // Per-task failures (local refusals, spawn refusals, no reply, create
  // failures) — printed as they happen, counted for the exit code.
  const problems = [];
  const bad = (task, status, reason) => {
    say(`factory: ${task} ${status} — ${reason}`);
    problems.push(task);
  };
  const { provider: providerId, model, thinking } = splitProvider(provider);
  say(renderRunBanner(tasks, provider));

  // The daemon is preflighted before any spawn line lands in the ledger: a
  // dispatched spawn with no agent behind it would be a lie the ledger keeps.
  const rpc = new DaemonRpc(home);
  try {
    await rpc.connect();
  } catch (err) {
    say(`factory: cannot reach the daemon — ${err.message}`);
    return 2;
  }

  const ledgerAtStart = readDriverLedger(stateDir);
  const entries = [];
  let created = 0;
  for (const task of tasks) {
    if (!TASK_ID_PATTERN.test(task)) {
      problems.push(bad(task, "refused locally", `task id "${task}" is invalid — use letters, digits, ".", "_", "-"`));
      continue;
    }
    const contract = contractFromLedger(ledgerAtStart, task);
    // The Task worktree (v0.0.14, ADR 0010 §4): a contracted task whose
    // workspace IS the Project root gets its isolated linked worktree
    // allocated BEFORE the spawn request — the local refusal law holds (a
    // worktree failure writes no ledger line), and the spawn request carries
    // the worktree path so the plugin can record it on `spawn_dispatched`
    // (claim, gate, and choke bind to it after that). A subdirectory
    // workspace (Implementation Decision 5's condition) keeps the legacy
    // single-checkout law: the branch switches in place, the agent's cwd
    // stays the workspace, and no worktree rides the spawn line — no
    // landing on accept either, exactly as before worktrees existed.
    let prep;
    if (contract !== undefined) {
      const prepared = prepareTaskWorkspace(stateDir, contract, task);
      if (!prepared.ok) {
        problems.push(bad(task, "refused locally", prepared.reason));
        continue;
      }
      if (prepared.legacy === true) {
        const legacy = prepareWorkspace(contract.workspace, task);
        if (!legacy.ok) {
          problems.push(bad(task, "refused locally", legacy.reason));
          continue;
        }
        prep = { ok: true, cwd: contract.workspace, branch: task };
        say(`factory: ${task} on branch ${task}${legacy.branchExisted ? " (existing — re-run)" : " (created)"} — workspace is a repo subdirectory, not the project root: single-checkout path`);
      } else {
        prep = prepared;
        say(`factory: ${task} in worktree ${prepared.cwd} on branch ${prepared.branch}${prepared.reset ? " (reset — re-run)" : " (created)"}`);
      }
    }
    // The spool owns the record: one spawn request per task, one ledger line
    // either way. Unknown tasks ride this path too — the plugin's refusal is
    // the recorded fact, not a local complaint.
    const request = {
      id: randomId(),
      kind: "spawn",
      task,
      provider,
      arity: tasks.length,
      ...(prep?.worktree === undefined ? {} : { worktree: prep.worktree }),
    };
    submit(spoolRoot, request);
    const reply = await awaitReply(spoolRoot, request.id, waitSecs * 1000);
    if (reply === null) {
      problems.push(bad(task, "no reply", `the factory plugin did not answer the spawn request within ${waitSecs}s — the request (${request.id}) stays in the spool`));
      continue;
    }
    if (!reply.ok) {
      problems.push(bad(task, "spawn refused", `${reply.code}: ${reply.message}`));
      continue;
    }
    if (contract === undefined) {
      // The plugin knows a contract the driver's local read did not (it was
      // set moments ago) — record the oddity rather than guess a workspace.
      problems.push(bad(task, "agent create failed", "the plugin dispatched a spawn the driver has no local contract for — re-read the ledger and re-run"));
      continue;
    }
    if (created > 0) await sleep(staggerMs); // CPU etiquette only — gates must not serialize (ticket 03 §7)
    try {
      // The agent's cwd is the task worktree (v0.0.14), and the brief names
      // the branch it is already on — `factory/<task>`, never the bare task
      // id the legacy shared-checkout path used.
      const branch = prep?.branch ?? task;
      const brief = renderBrief(task, process.env.PATH ?? "", contract.description, contract.skills, branch);
      const spawnSeq = reply.event?.seq;
      const idempotencyKey = spawnSeq !== undefined ? `${task}-spawn-${spawnSeq}` : task;
      const agentId = await createTaskAgent(rpc, {
        task,
        idempotencyKey,
        provider: providerId,
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking }),
        cwd: prep?.cwd ?? contract.workspace,
        brief,
        ...(reply.leadAgentId === undefined ? {} : { parent: reply.leadAgentId }),
        ...(reply.workspaceId === undefined ? {} : { workspaceId: reply.workspaceId }),
        ...(reply.projectSlug === undefined ? {} : { projectSlug: reply.projectSlug }),
      });
      entries.push({
        task,
        agentId,
        workspace: prep?.cwd ?? contract.workspace,
        branch,
        brief,
        ...(reply.leadAgentId === undefined ? {} : { leadAgentId: reply.leadAgentId }),
        ...(reply.workspaceId === undefined ? {} : { workspaceId: reply.workspaceId }),
        ...(reply.projectSlug === undefined ? {} : { projectSlug: reply.projectSlug }),
      });
      created += 1;
      say(`factory: ${task} agent ${agentId.slice(0, 12)} created — watching to verdict`);
    } catch (err) {
      problems.push(bad(task, "agent create failed", `${err.code !== undefined ? `${err.code}: ` : ""}${err.message}`));
    }
  }

  // Each task's verdict is printed the moment its agent turns terminal
  // (ticket 03 §5: "at each task's verdict"), from a fresh ledger read —
  // the plugin wrote the verdict while the agent worked. The meter follows
  // the print (v0.0.8): the usage captured at the terminal moment rides one
  // spool request, and the plugin appends the `meter_written` line. The
  // Lead rider (v0.0.10 / v0.0.12) rides the same loop with both surfaces:
  // the ledger its predicate reads, and the spool its acts submit through.
  await observeTasks(rpc, entries, {
    pollMs,
    log: say,
    stateDir,
    spoolRoot,
    provider,
    onTerminal: async (entry) => {
      if (entry.terminal.fate !== "finished") {
        say(`factory: ${entry.task} agent ${entry.terminal.fate} — ${entry.terminal.reason ?? "no reason given"}`);
      }
      const outcome = taskOutcome(readDriverLedger(stateDir), entry.task);
      say(
        [
          `factory: ${entry.task} — attempt ${outcome.attempt === 0 ? "-" : outcome.attempt}`,
          `verdict=${outcome.verdict ?? "-"}`,
          `sha=${outcome.sha === undefined ? "-" : outcome.sha.slice(0, 7)}`,
          `report=${outcome.reportPath ?? "-"}`,
          `choke=${outcome.allowed}/${outcome.denied}/${outcome.blocked}`,
        ].join(" "),
      );
      if (!entry.metered) await submitMeter(spoolRoot, entry, provider, say);
    },
  });
  rpc.close();

  // Exit judgement from the ledger as it stands NOW — a task the driver
  // refused, failed to create, or whose agent died is already reported above.
  const ledgerAtEnd = readDriverLedger(stateDir);
  let allGreen = entries.every((entry) => {
    if (entry.terminal?.fate !== "finished") return false;
    return taskOutcome(ledgerAtEnd, entry.task).verdict === "green";
  });
  if (problems.length > 0) allGreen = false;
  say(allGreen ? "factory: run green — every task verified" : "factory: run NOT green");
  return allGreen ? 0 : 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
