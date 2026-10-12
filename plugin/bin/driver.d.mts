/**
 * The driver's declaration — see driver.mjs for why it exists (plain .mjs,
 * no build step, no plugin server imports). test/driver.test.ts runs the
 * pure pieces; the daemon-RPC half is proven live on the trial home.
 */

export declare const POLL_MS: number;
export declare const STAGGER_MS: number;
export declare const STALL_WARN_MS: number;
export declare const AGENT_MISSING_DEAD_MS: number;
/** The Lead's denial-stall grace (v0.0.10): fixed in code, never configuration. */
export declare const GRACE_MS: number;
/** How long a spent re-poke stays answerable before `needs_human` (v0.0.10). */
export declare const RE_STALL_MS: number;

export declare function renderBrief(task: string, pathValue: string, description?: string): string;
export declare function splitProvider(value: string): { provider: string; model: string | undefined };
export declare function renderRunBanner(tasks: readonly string[], provider: string): string;

export declare function readDriverLedger(stateDir: string): Record<string, unknown>[];
export declare function contractFromLedger(events: readonly Record<string, unknown>[], task: string): Record<string, unknown> | undefined;
export interface DriverOutcome {
  attempt: number;
  verdict: string | undefined;
  sha: string | undefined;
  reportPath: string | undefined;
  allowed: number;
  denied: number;
  blocked: number;
  accepted: boolean;
}
export declare function taskOutcome(events: readonly Record<string, unknown>[], task: string): DriverOutcome;

export declare function prepareWorkspace(
  workspace: string,
  task: string,
): { ok: true; branchExisted: boolean } | { ok: false; reason: string };

export declare class DaemonConnectionError extends Error {}
export declare class DaemonRpc {
  constructor(home: string);
  readonly features: Record<string, unknown> | null;
  get connected(): boolean;
  connect(timeoutMs?: number): Promise<void>;
  request(
    message: Record<string, unknown>,
    options: { responseType: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  deliver(msg: Record<string, unknown>): void;
  rejectAllPending(err: Error): void;
  close(): void;
}

export declare function createTaskAgent(
  rpc: DaemonRpc,
  input: { task: string; provider: string; model?: string; cwd: string; brief: string },
): Promise<string>;

export interface AgentFate {
  terminal: boolean;
  fate?: "finished" | "died" | "closed";
  reason?: string;
}
export declare function agentFate(agent: Record<string, unknown>): AgentFate;

// ---- the Lead rider (v0.0.10) ----

/** The re-poke's fixed text — only the task and the denial's rule interpolate. */
export declare function repokeText(task: string, rule: string): string;

export interface LeadDenial {
  seq: number;
  ts: string;
  rule: string;
}
export type LeadDecision =
  | { act: "poke"; denial: LeadDenial }
  | { act: "needs-human"; reason: "denied-again" | "silent-after-repoke"; evidence: { denial: number; repoke: number } }
  | { act: "watch"; why: string }
  | { act: "clear" };
/** The Lead's one decision over a task's ledger slice — pure ledger arithmetic (graceMs/reStallMs: test knobs, the code defaults are the fixed law). */
export declare function leadDecision(
  events: readonly Record<string, unknown>[],
  task: string,
  now?: number,
  windows?: { graceMs?: number; reStallMs?: number },
): LeadDecision;
/** Post-spawn evidence of life (the death fix): any task event after this run's spawn that is not the driver's or the Lead's own writing. */
export declare function postSpawnLife(events: readonly Record<string, unknown>[], task: string): boolean;
/** This run's `gate_finished`, if the ledger already holds one — the null lane's finish signal. */
export declare function verdictOfThisRun(events: readonly Record<string, unknown>[], task: string): Record<string, unknown> | undefined;

/** The daemon's usage snapshot reduced to the four meter fields, present only when finite (v0.0.8). */
export interface MeterUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}
export declare function usageOf(lastUsage: unknown): MeterUsage;
/** The re-fetch race rule: the later snapshot wins unless it came back emptier. */
export declare function pickUsage(terminal: MeterUsage, refetched: MeterUsage): MeterUsage;

export interface ObserveEntry {
  task: string;
  agentId: string;
  /** Set the moment the task lands its terminal state — the loop's own bookkeeping. */
  terminal?: { terminal?: boolean; fate: string; reason?: string };
  /** The terminal usage capture (v0.0.8) — undefined until a terminal moment. */
  usage?: MeterUsage;
}
export declare function observeTasks(
  rpc: DaemonRpc | {
    connected: boolean;
    request(message: Record<string, unknown>, options: { responseType: string; timeoutMs?: number }): Promise<Record<string, unknown>>;
    close(): void;
  },
  entries: ObserveEntry[],
  options?: {
    pollMs?: number;
    log?: (message: string) => void;
    onTerminal?: (entry: ObserveEntry) => void | Promise<void>;
    /** The Lead rider's surfaces (v0.0.10): the ledger its predicate reads, the spool its two acts submit through. */
    stateDir: string;
    spoolRoot: string;
    /** Test knobs (defaults are the fixed laws: AGENT_MISSING_DEAD_MS, GRACE_MS, RE_STALL_MS). */
    missingDeadMs?: number;
    graceMs?: number;
    reStallMs?: number;
  },
): Promise<void>;

export interface RunDriverInput {
  home: string;
  stateDir: string;
  spoolRoot: string;
  tasks: string[];
  provider: string;
  waitSecs?: number;
  pollMs?: number;
  staggerMs?: number;
  log?: (message: string) => void;
}
export declare function runDriver(input: RunDriverInput): Promise<number>;
