/**
 * Coalesced state-invalidation hub for the Factory UI (`factory.state.updates`).
 *
 * Keeps a single reference-counted set of daemon subscriptions (`agents`,
 * `workspaces`, `projects`, `providers`) active only while at least one client
 * is subscribed, coalesces burst invalidations per Project scope without ever
 * spawning `git`, and serializes `push()` calls per subscriber until its
 * `AbortSignal` aborts or `stop()` runs.
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { listProjectRegistrations, readProjectRegistration } from "./core/project.ts";
import { parseTaskWorktreePath } from "./core/workspace.ts";

export interface StateHubTarget {
  projectSlug?: string;
  projectRoot?: string;
}

export interface StateUpdateEvent {
  seq: number;
  reasons: string[];
  projectSlug?: string;
  projectRoot?: string;
  at: string;
}

export interface StateHubSubscriptionInput {
  projectRoot?: string;
}

export interface StateHubSubscriptionContext {
  push(event: StateUpdateEvent): Promise<void>;
  signal: AbortSignal;
}

export interface StateHubDaemonLike {
  agents?: {
    list?: (options?: { subscribe?: Record<string, never> }) => Promise<unknown>;
    subscribe?: (handler: (update: unknown) => void) => unknown;
  };
  workspaces?: {
    list?: (options?: { subscribe?: Record<string, never> }) => Promise<unknown>;
    subscribe?: (handler: (update: unknown) => void) => unknown;
  };
  projects?: {
    subscribe?: (handler: (update: unknown) => void) => unknown;
  };
  providers?: {
    subscribe?: (handler: (update: unknown) => void) => unknown;
  };
}

export interface StateHubOptions {
  stateDir: string;
  coalesceMs?: number;
  onLog?: (message: string) => void;
}

export interface StateHub {
  subscribe(input: StateHubSubscriptionInput, context: StateHubSubscriptionContext): void;
  emit(reason: string, target?: StateHubTarget): void;
  attachDaemon(paseo: unknown): void;
  stop(): void;
}

interface ResolvedScope {
  projectSlug?: string;
  projectRoot?: string;
  normalizedRoot?: string;
}

interface PendingBucket {
  reasons: Set<string>;
  projectSlug?: string;
  projectRoot?: string;
  normalizedRoot?: string;
  timer: ReturnType<typeof setTimeout>;
}

interface SubscriberEntry {
  normalizedRoot?: string;
  signal: AbortSignal;
  push: (event: StateUpdateEvent) => Promise<void>;
  pushChain: Promise<void>;
  cleanup: () => void;
}

const DEFAULT_COALESCE_MS = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function realpathSafe(targetPath: string): string {
  const abs = resolve(targetPath);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isPathWithin(childPath: string, parentPath: string): boolean {
  if (childPath === parentPath) return true;
  if (parentPath === sep) return childPath.startsWith(sep);
  return childPath.startsWith(`${parentPath}${sep}`);
}

function normalizeNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function resolveScopeFromPath(stateDir: string, normalizedStateDir: string, rawPath: string): ResolvedScope {
  const abs = resolve(rawPath);
  const normalized = realpathSafe(abs);
  const worktree =
    parseTaskWorktreePath(normalizedStateDir, normalized) ??
    parseTaskWorktreePath(resolve(stateDir), abs);
  if (worktree !== null) {
    const reg = readProjectRegistration(stateDir, worktree.slug);
    if (reg !== undefined) {
      return {
        projectSlug: reg.slug,
        projectRoot: reg.root,
        normalizedRoot: realpathSafe(reg.root),
      };
    }
    return {
      projectSlug: worktree.slug,
      projectRoot: rawPath,
      normalizedRoot: normalized,
    };
  }

  let bestMatch: { slug: string; root: string; normalizedRoot: string } | undefined;
  for (const reg of listProjectRegistrations(stateDir)) {
    const regNormalized = realpathSafe(reg.root);
    if (isPathWithin(normalized, regNormalized)) {
      if (bestMatch === undefined || regNormalized.length > bestMatch.normalizedRoot.length) {
        bestMatch = { slug: reg.slug, root: reg.root, normalizedRoot: regNormalized };
      }
    }
  }
  if (bestMatch !== undefined) {
    return {
      projectSlug: bestMatch.slug,
      projectRoot: bestMatch.root,
      normalizedRoot: bestMatch.normalizedRoot,
    };
  }
  return {
    projectRoot: rawPath,
    normalizedRoot: normalized,
  };
}

function resolveTargetWithoutGit(stateDir: string, normalizedStateDir: string, target?: StateHubTarget): ResolvedScope {
  const slug = normalizeNonEmpty(target?.projectSlug);
  const root = normalizeNonEmpty(target?.projectRoot);

  if (slug !== undefined) {
    const reg = readProjectRegistration(stateDir, slug);
    if (reg !== undefined) {
      return {
        projectSlug: reg.slug,
        projectRoot: reg.root,
        normalizedRoot: realpathSafe(reg.root),
      };
    }
    return {
      projectSlug: slug,
      ...(root !== undefined ? { projectRoot: root, normalizedRoot: realpathSafe(root) } : {}),
    };
  }

  if (root !== undefined) {
    return resolveScopeFromPath(stateDir, normalizedStateDir, root);
  }

  return {};
}

function targetFromAgentUpdate(update: unknown): StateHubTarget | undefined {
  const agent = (update as { agent?: { cwd?: unknown; labels?: Record<string, unknown> } } | undefined)?.agent;
  if (agent === undefined || agent === null || typeof agent !== "object") return undefined;
  const projectRoot = normalizeNonEmpty(agent.cwd);
  const projectSlug = normalizeNonEmpty(agent.labels?.project);
  if (projectRoot === undefined && projectSlug === undefined) return undefined;
  return {
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectSlug !== undefined ? { projectSlug } : {}),
  };
}

function targetFromWorkspaceUpdate(update: unknown): StateHubTarget | undefined {
  const workspace = (update as { workspace?: { projectRootPath?: unknown; workspaceDirectory?: unknown } } | undefined)?.workspace;
  if (workspace === undefined || workspace === null || typeof workspace !== "object") return undefined;
  const projectRoot = normalizeNonEmpty(workspace.projectRootPath) ?? normalizeNonEmpty(workspace.workspaceDirectory);
  return projectRoot !== undefined ? { projectRoot } : undefined;
}

function targetFromProjectUpdate(update: unknown): StateHubTarget | undefined {
  const project = (update as { project?: { projectRootPath?: unknown } } | undefined)?.project;
  if (project === undefined || project === null || typeof project !== "object") return undefined;
  const projectRoot = normalizeNonEmpty(project.projectRootPath);
  return projectRoot !== undefined ? { projectRoot } : undefined;
}

function releaseCleanup(cleanup: unknown): void {
  if (typeof cleanup !== "function") return;
  try {
    (cleanup as () => void)();
  } catch {
    // best-effort unsubscribe
  }
}

function releaseSubscription(subscription: unknown): void {
  if (subscription === undefined || subscription === null) return;
  try {
    const maybeObj = subscription as { release?: unknown };
    if (typeof maybeObj.release === "function") {
      void Promise.resolve((maybeObj.release as () => unknown)()).catch(() => {});
      return;
    }
    if (typeof subscription === "function") {
      (subscription as () => void)();
    }
  } catch {
    // best-effort release
  }
}

export function createStateHub(options: StateHubOptions): StateHub {
  const { stateDir, onLog } = options;
  const normalizedStateDir = realpathSafe(stateDir);
  const coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);

  const subscribers = new Set<SubscriberEntry>();
  const pendingByScope = new Map<string, PendingBucket>();

  let seq = 0;
  let stopped = false;
  let daemon: StateHubDaemonLike | undefined;
  let daemonAttached = false;
  let attachGeneration = 0;
  let activeCleanups: unknown[] = [];
  let activeSubscriptions: unknown[] = [];

  const matchesSubscriber = (sub: SubscriberEntry, bucket: PendingBucket): boolean => {
    // Global events notify every subscriber; global subscribers receive every event.
    if (bucket.projectSlug === undefined && bucket.normalizedRoot === undefined) return true;
    if (sub.normalizedRoot === undefined) return true;

    const subScope = resolveScopeFromPath(stateDir, normalizedStateDir, sub.normalizedRoot);
    if (subScope.projectSlug !== undefined && bucket.projectSlug !== undefined) {
      return subScope.projectSlug === bucket.projectSlug;
    }
    if (bucket.normalizedRoot !== undefined) {
      return (
        isPathWithin(bucket.normalizedRoot, sub.normalizedRoot) ||
        isPathWithin(sub.normalizedRoot, bucket.normalizedRoot)
      );
    }
    return false;
  };

  const detachDaemonSubs = (): void => {
    attachGeneration += 1;
    daemonAttached = false;
    const cleanups = activeCleanups;
    const subs = activeSubscriptions;
    activeCleanups = [];
    activeSubscriptions = [];
    for (const cleanup of cleanups) releaseCleanup(cleanup);
    for (const sub of subs) releaseSubscription(sub);
  };

  const ensureDaemonSubsAttached = (): void => {
    if (stopped || daemonAttached || daemon === undefined || subscribers.size === 0) return;
    daemonAttached = true;
    const gen = ++attachGeneration;
    const currentDaemon = daemon;
    const isStale = (): boolean => stopped || !daemonAttached || gen !== attachGeneration || subscribers.size === 0;

    const trackListSubscription = (label: string, promiseResult: unknown): void => {
      void Promise.resolve(promiseResult).then(
        (result) => {
          const sub = (result as { subscription?: unknown } | undefined)?.subscription;
          if (isStale()) {
            releaseSubscription(sub);
            return;
          }
          if (sub !== undefined) activeSubscriptions.push(sub);
        },
        (error) => {
          onLog?.(`state-hub: ${label}.list subscribe failed — ${errorMessage(error)}`);
        },
      );
    };

    if (typeof currentDaemon.agents?.subscribe === "function") {
      try {
        const unsub = currentDaemon.agents.subscribe((update) => {
          if (isStale()) return;
          emit("daemon.agents", targetFromAgentUpdate(update));
        });
        if (isStale()) releaseCleanup(unsub);
        else activeCleanups.push(unsub);
      } catch (error) {
        onLog?.(`state-hub: agents.subscribe failed — ${errorMessage(error)}`);
      }
      if (!isStale() && typeof currentDaemon.agents.list === "function") {
        try {
          trackListSubscription("agents", currentDaemon.agents.list({ subscribe: {} }));
        } catch (error) {
          onLog?.(`state-hub: agents.list subscribe failed — ${errorMessage(error)}`);
        }
      }
    }

    if (!isStale() && typeof currentDaemon.workspaces?.subscribe === "function") {
      try {
        const unsub = currentDaemon.workspaces.subscribe((update) => {
          if (isStale()) return;
          emit("daemon.workspaces", targetFromWorkspaceUpdate(update));
        });
        if (isStale()) releaseCleanup(unsub);
        else activeCleanups.push(unsub);
      } catch (error) {
        onLog?.(`state-hub: workspaces.subscribe failed — ${errorMessage(error)}`);
      }
      if (!isStale() && typeof currentDaemon.workspaces.list === "function") {
        try {
          trackListSubscription("workspaces", currentDaemon.workspaces.list({ subscribe: {} }));
        } catch (error) {
          onLog?.(`state-hub: workspaces.list subscribe failed — ${errorMessage(error)}`);
        }
      }
    }

    if (!isStale() && typeof currentDaemon.projects?.subscribe === "function") {
      try {
        const unsub = currentDaemon.projects.subscribe((update) => {
          if (isStale()) return;
          emit("daemon.projects", targetFromProjectUpdate(update));
        });
        if (isStale()) releaseCleanup(unsub);
        else activeCleanups.push(unsub);
      } catch (error) {
        onLog?.(`state-hub: projects.subscribe failed — ${errorMessage(error)}`);
      }
    }

    if (!isStale() && typeof currentDaemon.providers?.subscribe === "function") {
      try {
        const unsub = currentDaemon.providers.subscribe(() => {
          if (isStale()) return;
          emit("daemon.providers");
        });
        if (isStale()) releaseCleanup(unsub);
        else activeCleanups.push(unsub);
      } catch (error) {
        onLog?.(`state-hub: providers.subscribe failed — ${errorMessage(error)}`);
      }
    }
  };

  const flushBucket = (scopeKey: string): void => {
    const bucket = pendingByScope.get(scopeKey);
    if (bucket === undefined) return;
    pendingByScope.delete(scopeKey);
    if (stopped || subscribers.size === 0) return;

    const matching = [...subscribers].filter((sub) => !sub.signal.aborted && matchesSubscriber(sub, bucket));
    if (matching.length === 0) return;

    const event: StateUpdateEvent = {
      seq: ++seq,
      reasons: [...bucket.reasons],
      ...(bucket.projectSlug !== undefined ? { projectSlug: bucket.projectSlug } : {}),
      ...(bucket.projectRoot !== undefined ? { projectRoot: bucket.projectRoot } : {}),
      at: new Date().toISOString(),
    };

    for (const sub of matching) {
      sub.pushChain = sub.pushChain.then(async () => {
        if (stopped || sub.signal.aborted) return;
        try {
          await sub.push(event);
        } catch (error) {
          onLog?.(`state-hub: push failed — ${errorMessage(error)}`);
        }
      });
    }
  };

  const emit = (reason: string, target?: StateHubTarget): void => {
    if (stopped || subscribers.size === 0) return;
    const normalizedReason = normalizeNonEmpty(reason);
    if (normalizedReason === undefined) return;

    const resolved = resolveTargetWithoutGit(stateDir, normalizedStateDir, target);
    const scopeKey =
      resolved.projectSlug !== undefined
        ? `slug:${resolved.projectSlug}`
        : resolved.normalizedRoot !== undefined
          ? `root:${resolved.normalizedRoot}`
          : "global";

    const existing = pendingByScope.get(scopeKey);
    if (existing !== undefined) {
      existing.reasons.add(normalizedReason);
      return;
    }

    const timer = setTimeout(() => {
      flushBucket(scopeKey);
    }, coalesceMs);
    timer.unref?.();

    pendingByScope.set(scopeKey, {
      reasons: new Set([normalizedReason]),
      ...(resolved.projectSlug !== undefined ? { projectSlug: resolved.projectSlug } : {}),
      ...(resolved.projectRoot !== undefined ? { projectRoot: resolved.projectRoot } : {}),
      ...(resolved.normalizedRoot !== undefined ? { normalizedRoot: resolved.normalizedRoot } : {}),
      timer,
    });
  };

  const subscribe = (input: StateHubSubscriptionInput, context: StateHubSubscriptionContext): void => {
    if (stopped || context.signal.aborted) return;
    const rawRoot = normalizeNonEmpty(input?.projectRoot);
    const normalizedRoot = rawRoot !== undefined ? realpathSafe(rawRoot) : undefined;

    const entry: SubscriberEntry = {
      ...(normalizedRoot !== undefined ? { normalizedRoot } : {}),
      signal: context.signal,
      push: context.push,
      pushChain: Promise.resolve(),
      cleanup: () => {},
    };

    const onAbort = (): void => {
      entry.cleanup();
      if (!subscribers.delete(entry)) return;
      if (subscribers.size === 0) detachDaemonSubs();
    };

    entry.cleanup = () => {
      context.signal.removeEventListener("abort", onAbort);
    };

    subscribers.add(entry);
    context.signal.addEventListener("abort", onAbort, { once: true });

    if (context.signal.aborted) {
      onAbort();
      return;
    }

    if (subscribers.size === 1) {
      ensureDaemonSubsAttached();
    }
  };

  const attachDaemon = (paseo: unknown): void => {
    if (stopped || paseo === undefined || paseo === null) return;
    const next = paseo as StateHubDaemonLike;
    if (daemon !== next) {
      if (daemonAttached) detachDaemonSubs();
      daemon = next;
    }
    if (subscribers.size > 0 && !daemonAttached) {
      ensureDaemonSubsAttached();
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const bucket of pendingByScope.values()) {
      clearTimeout(bucket.timer);
    }
    pendingByScope.clear();
    detachDaemonSubs();
    for (const entry of subscribers) {
      entry.cleanup();
    }
    subscribers.clear();
  };

  return {
    subscribe,
    emit,
    attachDaemon,
    stop,
  };
}
