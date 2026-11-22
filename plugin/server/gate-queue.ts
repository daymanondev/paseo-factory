import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PeerHandoffFields } from "./core/events.ts";
import type { ClaimOutcome, Factory } from "./core/factory.ts";
import { atomicJson, readOptionalJson } from "./core/json-store.ts";
import { projectStateDir } from "./core/project.ts";
import type { FactoryRegistry } from "./projects.ts";

export const GATE_QUEUE_SCHEMA_VERSION = 1 as const;
export const GATE_QUEUE_FILENAME = "gate-queue.json";

export interface GateQueueItem {
  id: string;
  projectSlug: string;
  useRootFactory?: boolean;
  task: string;
  attempt: number;
  sha: string;
  cmd: string;
  cwd: string;
  artifact?: string;
  timeoutMs: number;
  agent?: string;
  handoff?: PeerHandoffFields;
  mechanical?: "lead_verify";
  enqueuedAt: string;
  startedAt?: string;
  status: "queued" | "running";
  pid?: number;
}

export interface GateQueueFile {
  schemaVersion: typeof GATE_QUEUE_SCHEMA_VERSION;
  paused: boolean;
  pausedAt?: string;
  concurrency: number;
  items: GateQueueItem[];
}

export interface GateQueueAheadEntry {
  id: string;
  projectSlug: string;
  task: string;
  attempt: number;
  status: "queued" | "running";
}

export interface GateQueueEnqueueInput {
  id?: string;
  projectSlug: string;
  useRootFactory?: boolean;
  task: string;
  attempt: number;
  sha: string;
  cmd: string;
  cwd: string;
  artifact?: string;
  timeoutMs: number;
  agent?: string;
  handoff?: PeerHandoffFields;
  mechanical?: "lead_verify";
}

export interface GateQueueEnqueueResult {
  item: GateQueueItem;
  position: number;
  ahead: GateQueueAheadEntry[];
  paused: boolean;
}

export interface GateQueueSnapshot {
  paused: boolean;
  pausedAt?: string;
  concurrency: number;
  running: GateQueueItem[];
  queued: GateQueueItem[];
}

export interface GateQueueSettledContext {
  item: GateQueueItem;
  outcome: ClaimOutcome;
  restarted: boolean;
}

export interface GateQueueBootRecoveryResult {
  restartedRed: Array<{ projectSlug: string; task: string; attempt: number }>;
  resumedCount: number;
}

export interface GateQueueOptions {
  stateDir: string;
  factory: Factory;
  registry?: FactoryRegistry;
  concurrency?: number;
  onSettled?: (ctx: GateQueueSettledContext) => Promise<void> | void;
  onStateChange?: (snapshot: GateQueueSnapshot) => void;
  log?: (message: string) => void;
}

export interface GateQueueCancelOptions {
  note?: string;
  suppressSettled?: boolean;
}

export interface GateQueue {
  readonly path: string;
  enqueue(input: GateQueueEnqueueInput): GateQueueEnqueueResult;
  snapshot(): GateQueueSnapshot;
  hasRunning(projectSlug?: string): boolean;
  hasQueued(projectSlug?: string): boolean;
  pause(): GateQueueSnapshot;
  resume(): GateQueueSnapshot;
  setConcurrency(concurrency: number): GateQueueSnapshot;
  cancelItem(id: string, options?: string | GateQueueCancelOptions): Promise<boolean>;
  cancelMatching(predicate: (item: GateQueueItem) => boolean, options?: string | GateQueueCancelOptions): Promise<GateQueueItem[]>;
  startupRecovery(): Promise<GateQueueBootRecoveryResult>;
  stop(): void;
}

function normalizeConcurrency(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

function cloneItem(item: GateQueueItem): GateQueueItem {
  return {
    ...item,
    ...(item.handoff === undefined ? {} : { handoff: { ...item.handoff } }),
  };
}

function randomQueueId(): string {
  return `gq-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathInsideDir(targetPath: string, baseDir: string): boolean {
  const candidates = [resolve(targetPath), realpathSafe(targetPath)];
  const bases = [resolve(baseDir), realpathSafe(baseDir)];
  for (const target of candidates) {
    for (const base of bases) {
      const normalizedBase = base.endsWith(sep) ? base : `${base}${sep}`;
      if (target === base || target.startsWith(normalizedBase)) return true;
    }
  }
  return false;
}

/** True when a queued or running Gate entry belongs to the target Project by slug or checkout path. */
export function gateItemBelongsToProject(
  stateDir: string,
  slug: string,
  root: string,
  item: Pick<GateQueueItem, "projectSlug" | "cwd">,
): boolean {
  if (item.projectSlug === slug) return true;
  if (typeof item.cwd !== "string" || item.cwd.trim() === "") return false;
  const worktreesDir = join(projectStateDir(stateDir, slug), "worktrees");
  return isPathInsideDir(item.cwd, root) || isPathInsideDir(item.cwd, worktreesDir);
}

function isValidPersistedItem(raw: unknown): raw is GateQueueItem {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id.length > 0 &&
    typeof obj.projectSlug === "string" &&
    obj.projectSlug.length > 0 &&
    typeof obj.task === "string" &&
    obj.task.length > 0 &&
    typeof obj.attempt === "number" &&
    Number.isInteger(obj.attempt) &&
    obj.attempt >= 1 &&
    typeof obj.sha === "string" &&
    typeof obj.cmd === "string" &&
    typeof obj.cwd === "string" &&
    typeof obj.timeoutMs === "number" &&
    typeof obj.enqueuedAt === "string" &&
    (obj.status === "queued" || obj.status === "running")
  );
}

function readPersistedQueue(path: string, fallbackConcurrency: number): GateQueueFile | undefined {
  let raw: unknown;
  try {
    raw = readOptionalJson(path, "invalid-gate-queue");
  } catch {
    return undefined;
  }
  if (raw === undefined || typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const paused = obj.paused === true;
  const pausedAt = paused && typeof obj.pausedAt === "string" ? obj.pausedAt : undefined;
  const concurrency = normalizeConcurrency(obj.concurrency, fallbackConcurrency);
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems.filter(isValidPersistedItem).map((item) => cloneItem(item));
  return {
    schemaVersion: GATE_QUEUE_SCHEMA_VERSION,
    paused,
    ...(pausedAt === undefined ? {} : { pausedAt }),
    concurrency,
    items,
  };
}

function snapshotFromFile(file: GateQueueFile): GateQueueSnapshot {
  const running = file.items.filter((item) => item.status === "running").map(cloneItem);
  const queued = file.items.filter((item) => item.status === "queued").map(cloneItem);
  return {
    paused: file.paused,
    ...(file.pausedAt === undefined ? {} : { pausedAt: file.pausedAt }),
    concurrency: file.concurrency,
    running,
    queued,
  };
}

/**
 * Persisted machine-wide FIFO Gate queue (ADR 0068).
 *
 * Single-writer daemon queue stored at `<stateDir>/gate-queue.json`. Serializes
 * non-empty shell Gates across all registered Projects (default concurrency 1)
 * while allowing admission (`gate_queued`) and empty read-only Gates to return
 * immediately without holding seats or callers open.
 */
export function createGateQueue(options: GateQueueOptions): GateQueue {
  const queuePath = join(options.stateDir, GATE_QUEUE_FILENAME);
  const fallbackConcurrency = normalizeConcurrency(options.concurrency, 1);
  const persisted = readPersistedQueue(queuePath, fallbackConcurrency);
  const state: GateQueueFile = persisted ?? {
    schemaVersion: GATE_QUEUE_SCHEMA_VERSION,
    paused: false,
    concurrency: fallbackConcurrency,
    items: [],
  };
  if (persisted !== undefined && options.concurrency !== undefined) {
    state.concurrency = fallbackConcurrency;
  }

  let stopped = false;
  let recovered = false;
  const shutdownController = new AbortController();
  const activeRuns = new Map<
    string,
    {
      item: GateQueueItem;
      controller: AbortController;
      cancelNote?: string;
      suppressSettled?: boolean;
      completion: Promise<void>;
    }
  >();

  const emitChange = (): void => {
    options.onStateChange?.(snapshotFromFile(state));
  };

  const persist = (): void => {
    if (stopped) return;
    atomicJson(queuePath, {
      schemaVersion: GATE_QUEUE_SCHEMA_VERSION,
      paused: state.paused,
      ...(state.pausedAt === undefined ? {} : { pausedAt: state.pausedAt }),
      concurrency: state.concurrency,
      items: state.items,
    } satisfies GateQueueFile);
  };

  const resolveTargetFactory = (item: GateQueueItem): Factory => {
    if (item.useRootFactory === true || options.registry === undefined) {
      return options.factory;
    }
    return options.registry.factoryForProject(item.projectSlug);
  };

  const notifySettled = async (ctx: GateQueueSettledContext): Promise<void> => {
    if (options.onSettled === undefined) return;
    try {
      await options.onSettled(ctx);
    } catch (err) {
      options.log?.(`gate-queue: onSettled failed for ${ctx.item.task}#${ctx.item.attempt}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const startItem = (item: GateQueueItem): void => {
    const controller = new AbortController();
    const runEntry: {
      item: GateQueueItem;
      controller: AbortController;
      cancelNote?: string;
      suppressSettled?: boolean;
      completion: Promise<void>;
    } = {
      item,
      controller,
      completion: Promise.resolve(),
    };
    activeRuns.set(item.id, runEntry);

    runEntry.completion = (async () => {
      try {
        const targetFactory = resolveTargetFactory(item);
        const outcome = await targetFactory.executeQueuedClaim({
          task: item.task,
          attempt: item.attempt,
          sha: item.sha,
          ...(item.handoff === undefined ? {} : { handoff: item.handoff }),
          ...(item.mechanical === undefined ? {} : { mechanical: item.mechanical }),
          ...(item.agent === undefined ? {} : { agent: item.agent }),
          timeoutMs: item.timeoutMs,
          signal: controller.signal,
          shutdownSignal: shutdownController.signal,
          ...(runEntry.cancelNote === undefined ? {} : { cancelNote: runEntry.cancelNote }),
          onSpawn: (pid) => {
            if (stopped || pid === undefined) return;
            const current = state.items.find((entry) => entry.id === item.id);
            if (current === undefined || current.status !== "running") return;
            current.pid = pid;
            persist();
            emitChange();
          },
        });
        if (stopped || outcome === undefined) {
          return;
        }
        const idx = state.items.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) state.items.splice(idx, 1);
        persist();
        emitChange();
        if (!runEntry.suppressSettled) {
          await notifySettled({ item: cloneItem(item), outcome, restarted: false });
        }
      } catch (err) {
        if (stopped) return;
        options.log?.(`gate-queue: execution error on ${item.projectSlug}/${item.task}#${item.attempt}: ${err instanceof Error ? err.message : String(err)}`);
        const idx = state.items.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) state.items.splice(idx, 1);
        persist();
        emitChange();
      } finally {
        activeRuns.delete(item.id);
        if (!stopped) pump();
      }
    })();
  };

  const pump = (): void => {
    if (stopped || state.paused) return;
    let startedAny = false;
    while (activeRuns.size < state.concurrency) {
      const next = state.items.find((entry) => entry.status === "queued" && !activeRuns.has(entry.id));
      if (next === undefined) break;
      next.status = "running";
      next.startedAt = new Date().toISOString();
      startedAny = true;
      startItem(next);
    }
    if (startedAny) {
      persist();
      emitChange();
    }
  };

  return {
    path: queuePath,

    enqueue(input) {
      const existingIndex = state.items.findIndex(
        (entry) =>
          entry.task === input.task &&
          entry.attempt === input.attempt &&
          entry.projectSlug === input.projectSlug &&
          (entry.useRootFactory === true) === (input.useRootFactory === true),
      );
      if (existingIndex !== -1) {
        const existing = state.items[existingIndex]!;
        const ahead = state.items.slice(0, existingIndex).map((entry) => ({
          id: entry.id,
          projectSlug: entry.projectSlug,
          task: entry.task,
          attempt: entry.attempt,
          status: entry.status,
        }));
        return {
          item: cloneItem(existing),
          position: ahead.length + 1,
          ahead,
          paused: state.paused,
        };
      }

      const ahead: GateQueueAheadEntry[] = state.items.map((entry) => ({
        id: entry.id,
        projectSlug: entry.projectSlug,
        task: entry.task,
        attempt: entry.attempt,
        status: entry.status,
      }));
      const item: GateQueueItem = {
        id: input.id ?? randomQueueId(),
        projectSlug: input.projectSlug,
        ...(input.useRootFactory === true ? { useRootFactory: true } : {}),
        task: input.task,
        attempt: input.attempt,
        sha: input.sha,
        cmd: input.cmd,
        cwd: input.cwd,
        ...(input.artifact === undefined || input.artifact.trim() === "" ? {} : { artifact: input.artifact }),
        timeoutMs: input.timeoutMs,
        ...(input.agent === undefined || input.agent.trim() === "" ? {} : { agent: input.agent }),
        ...(input.handoff === undefined ? {} : { handoff: { ...input.handoff } }),
        ...(input.mechanical === undefined ? {} : { mechanical: input.mechanical }),
        enqueuedAt: new Date().toISOString(),
        status: "queued",
      };
      state.items.push(item);
      persist();
      emitChange();
      const position = ahead.length + 1;
      const result: GateQueueEnqueueResult = {
        item: cloneItem(item),
        position,
        ahead,
        paused: state.paused,
      };
      pump();
      return result;
    },

    snapshot() {
      return snapshotFromFile(state);
    },

    hasRunning(projectSlug) {
      return state.items.some(
        (entry) => entry.status === "running" && (projectSlug === undefined || entry.projectSlug === projectSlug),
      );
    },

    hasQueued(projectSlug) {
      return state.items.some(
        (entry) => entry.status === "queued" && (projectSlug === undefined || entry.projectSlug === projectSlug),
      );
    },

    pause() {
      if (!state.paused) {
        state.paused = true;
        state.pausedAt = new Date().toISOString();
        persist();
        emitChange();
      }
      return snapshotFromFile(state);
    },

    resume() {
      if (state.paused) {
        state.paused = false;
        delete state.pausedAt;
        persist();
        emitChange();
        pump();
      }
      return snapshotFromFile(state);
    },

    setConcurrency(concurrency) {
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`gate-queue concurrency must be an integer >= 1 (got ${concurrency})`);
      }
      state.concurrency = concurrency;
      persist();
      emitChange();
      pump();
      return snapshotFromFile(state);
    },

    async cancelItem(id, options = "cancelled-by-owner") {
      const removed = await this.cancelMatching((entry) => entry.id === id, options);
      return removed.length > 0;
    },

    async cancelMatching(predicate, options = "cancelled-by-owner") {
      const note = typeof options === "string" ? options : (options.note ?? "cancelled-by-owner");
      const suppressSettled = typeof options === "object" && options.suppressSettled === true;
      const matching = state.items.filter((entry) => predicate(cloneItem(entry)));
      if (matching.length === 0) return [];

      const cancelled: GateQueueItem[] = [];
      const activeCompletions: Promise<void>[] = [];
      const toRemoveQueuedIds = new Set<string>();

      for (const item of matching) {
        cancelled.push(cloneItem(item));
        const active = activeRuns.get(item.id);
        if (active !== undefined) {
          active.cancelNote = note;
          if (suppressSettled) active.suppressSettled = true;
          active.controller.abort(note);
          activeCompletions.push(active.completion);
        } else {
          toRemoveQueuedIds.add(item.id);
        }
      }

      if (toRemoveQueuedIds.size > 0) {
        state.items = state.items.filter((entry) => !toRemoveQueuedIds.has(entry.id));
        persist();
        emitChange();
      }

      if (activeCompletions.length > 0) {
        await Promise.allSettled(activeCompletions);
      }
      return cancelled;
    },

    async startupRecovery() {
      if (recovered) {
        return { restartedRed: [], resumedCount: 0 };
      }
      recovered = true;
      const staleRunning = state.items.filter((entry) => entry.status === "running" && !activeRuns.has(entry.id));
      const queuedItems = state.items.filter((entry) => entry.status === "queued");
      const restartedRed: GateQueueBootRecoveryResult["restartedRed"] = [];

      for (const item of staleRunning) {
        let outcome: ClaimOutcome | undefined;
        try {
          const targetFactory = resolveTargetFactory(item);
          outcome = targetFactory.recordDaemonRestarted({ task: item.task, attempt: item.attempt });
          restartedRed.push({ projectSlug: item.projectSlug, task: item.task, attempt: item.attempt });
        } catch (err) {
          options.log?.(`gate-queue: boot recovery skipped ${item.projectSlug}/${item.task}#${item.attempt}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Remove the settled `running` entry AFTER `resolveTargetFactory` opens
        // the ledger so `recoverInterruptedAttempts` sees it and defers to `daemon-restarted`.
        const idx = state.items.findIndex((entry) => entry.id === item.id);
        if (idx !== -1) state.items.splice(idx, 1);
        persist();
        emitChange();
        if (outcome !== undefined) {
          await notifySettled({ item: cloneItem(item), outcome, restarted: true });
        }
      }

      const resumedCount = queuedItems.length;
      if (!state.paused && queuedItems.length > 0) {
        pump();
      }
      return { restartedRed, resumedCount };
    },

    stop() {
      if (stopped) return;
      stopped = true;
      shutdownController.abort();
    },
  };
}
