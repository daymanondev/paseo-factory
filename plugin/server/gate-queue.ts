import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PeerHandoffFields } from "./core/events.ts";
import type { ClaimOutcome, Factory } from "./core/factory.ts";
import {
  GATE_QUEUE_FILENAME,
  GATE_QUEUE_SCHEMA_VERSION,
  cloneGateQueueItem as cloneItem,
  normalizeGateQueueConcurrency as normalizeConcurrency,
  readPersistedGateQueue as readPersistedQueue,
  snapshotFromGateQueueFile as snapshotFromFile,
  type GateQueueFile,
  type GateQueueItem,
  type GateQueueSnapshot,
} from "./core/gate-queue-status.ts";
import { atomicJson } from "./core/json-store.ts";
import { listProjectRegistrations, projectStateDir, readProjectRegistration, resolveProject } from "./core/project.ts";
import type { FactoryRegistry } from "./projects.ts";

export { GATE_QUEUE_FILENAME, GATE_QUEUE_SCHEMA_VERSION, type GateQueueFile, type GateQueueItem, type GateQueueSnapshot };

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
  logPath?: string;
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

export function randomQueueId(): string {
  return `gq-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export interface GateProjectTarget {
  slug?: string;
  root?: string;
}

/**
 * Resolves `(slug, root)` for a Project target from explicit slug and/or
 * workspace/projectRoot path across registered Projects and git roots.
 */
export function resolveGateProjectTarget(input: {
  stateDir: string;
  project?: string;
  workspace?: string;
  requireKnownWorkspace?: boolean;
  allowUnregisteredDeleteTarget?: boolean;
  singleProjectFallback?: boolean;
}): GateProjectTarget | undefined {
  const rawRoot = input.workspace?.trim() ?? "";
  const rawSlug = input.project?.trim() ?? "";
  const regs = listProjectRegistrations(input.stateDir);
  if (rawRoot !== "") {
    const resolved = resolveProject(rawRoot);
    if (resolved.ok) {
      return { slug: rawSlug !== "" ? rawSlug : resolved.slug, root: resolved.root };
    }
    const normRaw = realpathSafe(resolve(rawRoot));
    const matched = regs.find(
      (reg) => reg.root === rawRoot || reg.slug === rawRoot || realpathSafe(resolve(reg.root)) === normRaw,
    );
    if (matched !== undefined) {
      return { slug: rawSlug !== "" ? rawSlug : matched.slug, root: matched.root };
    }
    if (input.allowUnregisteredDeleteTarget === true && rawSlug !== "") {
      const bySlug = readProjectRegistration(input.stateDir, rawSlug);
      return bySlug !== undefined ? { slug: bySlug.slug, root: bySlug.root } : { slug: rawSlug, root: rawRoot };
    }
    if (input.requireKnownWorkspace === true) return undefined;
    return { ...(rawSlug !== "" ? { slug: rawSlug } : {}), root: rawRoot };
  }
  if (rawSlug !== "") {
    const reg = readProjectRegistration(input.stateDir, rawSlug);
    return reg !== undefined ? { slug: reg.slug, root: reg.root } : { slug: rawSlug };
  }
  if (input.singleProjectFallback === true) {
    return regs.length === 1 ? { slug: regs[0]!.slug, root: regs[0]!.root } : undefined;
  }
  return undefined;
}

/** Cancels every queued and running Gate belonging to `(slug, root)` before maintenance. */
export async function cancelProjectGates(input: {
  gateQueue: GateQueue | undefined;
  stateDir: string;
  slug: string;
  root: string;
  note: string;
}): Promise<void> {
  const { gateQueue, stateDir, slug, root, note } = input;
  if (gateQueue === undefined) return;
  await gateQueue.cancelMatching(
    (item) => gateItemBelongsToProject(stateDir, slug, root, item),
    { note, suppressSettled: true },
  );
}

interface AbortControllerLike {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

/**
 * Uses native `AbortController` at runtime, falling back to a minimal
 * structural signal when evaluated inside restricted VM test sandboxes.
 */
function makeAbortController(): AbortControllerLike {
  if (typeof AbortController === "function") return new AbortController();
  const listeners = new Set<() => void>();
  let aborted = false;
  let reason: unknown = undefined;
  const signal = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    addEventListener(type: string, listener: (() => void) | { handleEvent?: () => void }) {
      if (type !== "abort" || aborted) return;
      const fn = typeof listener === "function" ? listener : () => listener.handleEvent?.();
      listeners.add(fn);
    },
    removeEventListener(type: string, listener: (() => void) | { handleEvent?: () => void }) {
      if (type !== "abort") return;
      if (typeof listener === "function") listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort(nextReason?: unknown) {
      if (aborted) return;
      aborted = true;
      reason = nextReason;
      const snapshot = [...listeners];
      listeners.clear();
      for (const fn of snapshot) fn();
    },
  };
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
  const shutdownController = makeAbortController();
  const activeRuns = new Map<
    string,
    {
      item: GateQueueItem;
      controller: AbortControllerLike;
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
    const controller = makeAbortController();
    const runEntry: {
      item: GateQueueItem;
      controller: AbortControllerLike;
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
        ...(input.logPath === undefined || input.logPath.trim() === "" ? {} : { logPath: input.logPath }),
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

    async cancelMatching(predicate, cancelOptions = "cancelled-by-owner") {
      const note = typeof cancelOptions === "string" ? cancelOptions : (cancelOptions.note ?? "cancelled-by-owner");
      const suppressSettled = typeof cancelOptions === "object" && cancelOptions.suppressSettled === true;
      const matching = state.items.filter((entry) => predicate(cloneItem(entry)));
      if (matching.length === 0) return [];

      const cancelled: GateQueueItem[] = [];
      const activeCompletions: Promise<void>[] = [];
      const toRemoveQueued: GateQueueItem[] = [];

      for (const item of matching) {
        cancelled.push(cloneItem(item));
        const active = activeRuns.get(item.id);
        if (active !== undefined) {
          active.cancelNote = note;
          if (suppressSettled) active.suppressSettled = true;
          active.controller.abort(note);
          activeCompletions.push(active.completion);
        } else {
          toRemoveQueued.push(item);
        }
      }

      if (toRemoveQueued.length > 0) {
        const removeIds = new Set(toRemoveQueued.map((item) => item.id));
        state.items = state.items.filter((entry) => !removeIds.has(entry.id));
        persist();
        emitChange();
        if (!suppressSettled) {
          for (const item of toRemoveQueued) {
            let outcome: ClaimOutcome | undefined;
            try {
              const targetFactory = resolveTargetFactory(item);
              outcome = targetFactory.cancelQueuedClaim({
                task: item.task,
                attempt: item.attempt,
                note,
              });
            } catch (err) {
              options.log?.(`gate-queue: cancelQueuedClaim failed for ${item.projectSlug}/${item.task}#${item.attempt}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (outcome !== undefined) {
              await notifySettled({ item: cloneItem(item), outcome, restarted: false });
            }
          }
        }
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
