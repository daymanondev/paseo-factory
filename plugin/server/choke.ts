/**
 * The choke (v0.0.4) — factory-side policy over every permit ask from a
 * contracted agent, plus the git shim's ledger ingestion.
 *
 * Mediation is listen + respond (mechanism facts, scout 2026-10-08, grade A):
 * there is no synchronous permission before-hook, so the plugin subscribes to
 * `agent.permission_requested` — which carries the FULL request including
 * `detail.command`, the exact shell line, which `permit ls --json` strips —
 * and answers through `PaseoAgentHandle.respondToPermission()`. A pending ask
 * parks the agent, so async answering is sound.
 *
 * "Contracted" is mechanical (map decision 5): the asking agent's cwd sits
 * inside a live Contract's workspace. Asks from anywhere else are not the
 * factory's business and get no answer from us — the daemon's own operator
 * flow handles them. Paseo persists permission decisions nowhere, so every
 * judged ask becomes one ledger line here first, then the response.
 *
 * The same judge serves the bypass battery through the spool's synthetic `ask`
 * request (the smoke-harness channel: the choke does not care who attempts the
 * escape) — that path answers in the spool reply instead of
 * `respondToPermission`, because there is no daemon ask to answer.
 */
import { readFileSync } from "node:fs";
import type { AgentPermissionRequest, AgentPermissionResponse, AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { Factory } from "./core/factory.ts";
import type { ContractSet } from "./core/events.ts";
import { FactoryError } from "./core/errors.ts";
import { judgeFilePath, judgeShellCommand, writableRootsFor } from "./core/choke.ts";
import type { ChokeDecision, MemoryFence } from "./core/choke.ts";
import type { AskRequest, SpoolReply } from "./spool.ts";

/**
 * The structural slice of PaseoApi the choke needs — tests pass a fake shaped
 * exactly like the real call path (`agents.ref(id).respondToPermission`).
 */
export interface PaseoResponderApi {
  agents: {
    ref(id: string): {
      respondToPermission(options: { requestId: string; response: AgentPermissionResponse }): Promise<void>;
    };
  };
}

/** The lifecycle event payload, structural so hermetic tests can build one. */
export interface PermissionAskedEvent {
  agent: { id: string; cwd: string };
  request: AgentPermissionRequest;
}

/** The claude catalog's "default" mode, labeled "Always Ask" (scout §2, grade A). */
export const PINNED_MODE_ID = "default";

export interface ChokeOptions {
  factory: Factory;
  /** For `~` expansion inside the writable set — injected, tests never touch the real home. */
  homeDir: string;
  /** One line per judged ask / failure — the shell prefixes and prints it. */
  onLog?: (message: string) => void;
}

export interface Choke {
  /** The `agent.permission_requested` listener. Never throws. */
  onPermissionAsked(event: PermissionAskedEvent, paseo: PaseoResponderApi): Promise<void>;
  /** The spool's synthetic-ask handler — the battery's vehicle into the same judge and ledger. */
  spoolAskHandler(request: AskRequest): SpoolReply;
  /**
   * The `agent.create` before-hook body (map decision 7): a contracted agent's
   * permission mode is pinned to "Always Ask" so asks always surface — no
   * asks would mean a blinded choke, the shim alone. Returns the rewritten
   * config, or undefined when nothing changes.
   */
  pinCreateMode(config: AgentSessionConfig): AgentSessionConfig | undefined;
}

export function createChoke(options: ChokeOptions): Choke {
  const { factory, homeDir } = options;
  const log = options.onLog ?? (() => {});

  // The memory write fence's context (v0.0.14, ADR 0010 §6): every judged ask
  // comes from a contracted agent, so the live Contract's workspace and scope
  // ride into the core judges — write/edit asks and shell destinations both.
  const fenceOf = (contract: ContractSet): MemoryFence => ({ workspace: contract.workspace, scope: contract.scope });

  const decide = (request: AgentPermissionRequest, workspace: string, memory?: MemoryFence): { decision: ChokeDecision; command?: string } => {
    const roots = writableRootsFor(workspace, factory.stateDir, homeDir);
    const detail = request.detail;
    if (detail !== undefined && detail.type === "shell" && typeof detail.command === "string") {
      return { decision: judgeShellCommand(detail.command, roots, memory), command: detail.command };
    }
    if (
      detail !== undefined &&
      (detail.type === "write" || detail.type === "edit") &&
      typeof detail.filePath === "string"
    ) {
      // The write/edit rider (ticket 01's non-shell twin of S2), fenced over
      // the workspace-root memory files. The file path rides on the line so
      // the ledger names what was aimed at.
      return { decision: judgeFilePath(detail.filePath, roots, memory), command: detail.filePath };
    }
    // No shell line and no file target (plan/question/mode asks, reads): the
    // deny-list has nothing to match — default-allow.
    return { decision: { behavior: "allow" } };
  };

  return {
    async onPermissionAsked({ agent, request }, paseo) {
      let contract;
      try {
        contract = factory.liveContractFor(agent.cwd);
      } catch (err) {
        log(`choke: contract lookup failed for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (contract === undefined) return; // not a contracted agent — not our ask to answer
      const { decision, command } = decide(request, contract.workspace, fenceOf(contract));
      const response = recordAsk(factory, log, {
        task: contract.task,
        agent: agent.id,
        name: request.name,
        kind: request.kind,
        ...(command === undefined ? {} : { command }),
      }, decision);
      if (response === undefined) return; // the line never landed — do not answer what is not recorded
      try {
        await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response });
      } catch (err) {
        // The line is already in the ledger; a failed response leaves the ask
        // pending for the daemon's own operator flow — loud, never fatal.
        log(
          `choke: recorded the ask from agent ${agent.id} but could not answer it ` +
            `(${err instanceof Error ? err.message : String(err)}) — the ask stays pending`,
        );
      }
    },

    spoolAskHandler(request) {
      const contract = factory.contractFor(request.task);
      if (contract === undefined) {
        throw new FactoryError("unknown-task", `no contract set for task ${request.task} — register one first`);
      }
      const cwd = request.cwd ?? contract.workspace;
      const live = factory.liveContractFor(cwd);
      if (live === undefined || live.task !== request.task) {
        throw new FactoryError(
          "not-contracted",
          `task ${request.task} has no live contract covering ${cwd} — the choke judges contracted work only`,
        );
      }
      const decision = judgeShellCommand(request.command, writableRootsFor(live.workspace, factory.stateDir, homeDir), fenceOf(live));
      const base = {
        task: request.task,
        agent: request.agent ?? "spool-ask",
        name: request.name ?? "shell",
        kind: "tool",
        command: request.command,
      };
      if (decision.behavior === "deny") {
        factory.ledger.append({ ...base, event: "permit_denied", rule: decision.rule, reason: decision.reason });
        log(`choke: DENIED ${request.task} via spool ask (${decision.rule}): ${request.command}`);
        return {
          id: request.id,
          ok: true,
          summary: `ask denied (${decision.rule}): ${decision.reason}`,
          decision: "denied" as const,
          rule: decision.rule,
          reason: decision.reason,
        };
      }
      factory.ledger.append({ ...base, event: "permit_allowed" });
      log(`choke: allowed ${request.task} via spool ask: ${request.command}`);
      return {
        id: request.id,
        ok: true,
        summary: "ask allowed",
        decision: "allowed" as const,
      };
    },

    pinCreateMode(config) {
      let covered;
      try {
        covered = factory.liveContractFor(config.cwd) !== undefined;
      } catch {
        return undefined; // never block agent creation on a lookup failure
      }
      if (!covered || config.modeId === PINNED_MODE_ID) return undefined;
      return { ...config, modeId: PINNED_MODE_ID };
    },
  };
}

/**
 * One judged ask becomes one ledger line first, then the answer to hand back.
 * Returns undefined when the line could not be recorded — the caller must not
 * answer what the ledger does not carry.
 */
function recordAsk(
  factory: Factory,
  log: (message: string) => void,
  base: { task: string; agent: string; name: string; kind: string; command?: string },
  decision: ChokeDecision,
): AgentPermissionResponse | undefined {
  try {
    if (decision.behavior === "deny") {
      factory.ledger.append({ ...base, event: "permit_denied", rule: decision.rule, reason: decision.reason });
      log(`choke: DENIED ${base.task} agent ${base.agent} (${decision.rule}): ${base.command ?? base.name}`);
    } else {
      factory.ledger.append({ ...base, event: "permit_allowed" });
      log(`choke: allowed ${base.task} agent ${base.agent}: ${base.command ?? base.name}`);
    }
  } catch (err) {
    log(`choke: could not record the ask from agent ${base.agent}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  return decision.behavior === "deny"
    ? { behavior: "deny", message: `paseo-factory choke: ${decision.reason} (${decision.rule})`, interrupt: false }
    : { behavior: "allow" };
}

// ---- the git shim's ledger ingestion -----------------------------------------------------------

/** Where the shim appends its refusal lines (one JSON object per line). */
export function gitBlockLogPath(stateDir: string): string {
  return `${stateDir}/git-blocked.log`;
}

export interface GitBlockIngestion {
  stop(): void;
}

export interface GitBlockOptions {
  onLog?: (message: string) => void;
  /** Poll cadence. Default 250ms, the spool's cadence. */
  pollMs?: number;
}

interface ShimLine {
  id: string;
  command: string;
  rule: string;
  reason: string;
  cwd: string;
  agent?: string;
}

/**
 * Feeds the shim's refusal log into the ledger: each complete line becomes one
 * `git_blocked` event, bound to the live Contract covering its cwd when one
 * exists (the shim itself refuses no matter who runs it — binding is the
 * plugin's afterthought). Exactly-once by the line's id: the seen-set is
 * seeded from the ledger at boot, so a plugin restart never double-records a
 * refusal. Malformed lines are logged loudly and skipped — never appended,
 * never crashed on.
 */
export function startGitBlockIngestion(factory: Factory, options: GitBlockOptions = {}): GitBlockIngestion {
  const stateDir = factory.stateDir;
  const log = options.onLog ?? (() => {});
  const seen = new Set<string>(
    factory.ledger.events.filter((e) => e.event === "git_blocked").map((e) => e.blockId),
  );

  const ingest = (): void => {
    let raw: string;
    try {
      raw = readFileSync(gitBlockLogPath(stateDir), "utf8");
    } catch {
      return; // no refusals yet — the common case
    }
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop(); // the complete lines only; a tail mid-write waits for its newline
    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log(`git-blocked ingestion: skipping a malformed line: ${line.slice(0, 120)}`);
        continue;
      }
      const record = parsed as Partial<ShimLine>;
      if (
        typeof record.id !== "string" ||
        record.id === "" ||
        typeof record.command !== "string" ||
        typeof record.rule !== "string" ||
        typeof record.reason !== "string" ||
        typeof record.cwd !== "string"
      ) {
        log(`git-blocked ingestion: skipping a line with missing fields: ${line.slice(0, 120)}`);
        continue;
      }
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      const contract = factory.liveContractFor(record.cwd);
      factory.ledger.append({
        event: "git_blocked",
        ...(contract === undefined ? {} : { task: contract.task }),
        ...(record.agent === undefined || record.agent === "" ? {} : { agent: record.agent }),
        command: record.command,
        rule: record.rule,
        reason: record.reason,
        cwd: record.cwd,
        blockId: record.id,
      });
      log(`git blocked: ${record.command} (${record.rule})${contract === undefined ? "" : ` — task ${contract.task}`}`);
    }
  };

  const timer = setInterval(ingest, options.pollMs ?? 250);
  ingest();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
