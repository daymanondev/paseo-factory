/**
 * Shared client-side async onboarding run tracker (ADR 0065).
 * Drives Step 4 live progress, `factory.state.updates` (`onboarding.progress`)
 * subscriptions on `>= 0.16.0`, bounded polling fallback on `< 0.16.0`, silent
 * transient poll-error retry, automatic re-attach by canonical folder, and
 * active vs. background completion across both `OnboardingScreen` and
 * `FactoryShell`. Function-style only — no class syntax reaches Hermes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OnboardingPhaseStatus, OnboardingRun, OnboardingRunResult } from "../../shared/rpc.ts";
import { stateUpdates } from "../../shared/rpc.ts";
import { isSubscriptionLive, useClientSubscription } from "../kit/subscription.ts";
import { describeThrown } from "./onboarding-state.ts";
import type { CommitInput } from "./onboarding-state.ts";
import { normalizeFolderPath } from "./onboarding-targets.ts";

type Failed = { ok: false; error: string };

const TRANSIENT_POLL_WARNING_THRESHOLD = 3;
const DEFAULT_POLL_MS = 750;
const LIVE_BACKSTOP_POLL_MS = 2000;
const POLL_WARNING_TEXT = "Temporary connection hiccup checking onboarding status — still retrying…";

export interface OpenWorkspaceState {
  status: OnboardingPhaseStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export const INITIAL_OPEN_WORKSPACE: OpenWorkspaceState = {
  status: "pending",
  startedAt: null,
  finishedAt: null,
  error: null,
};

interface WatchedRun {
  run: OnboardingRun;
  folders: Set<string>;
  commitInput: CommitInput | null;
  pollFailures: number;
  inFlight: boolean;
  pendingRefresh: boolean;
  finalized: boolean;
}

export interface OnboardingRunTrackerOptions {
  /** Currently active onboarding folder in view (`null` when browsing / left onboarding). */
  activeFolder: string | null;
  /** Start RPC (`factory.onboarding.start` or test double). */
  start: (input: CommitInput) => Promise<{ ok: true; run?: OnboardingRun } | Failed>;
  /** Status RPC (`factory.onboarding.status`). */
  status?: (input: { runId?: string; folder?: string }) => Promise<{ ok: true; run: OnboardingRun | null } | Failed>;
  /** Client-side `open-workspace` finalization when the Owner is still active on the folder's onboarding view. */
  onActiveComplete?: (
    result: OnboardingRunResult,
    input: CommitInput | null,
    runId: string,
    isActive: () => boolean,
  ) => Promise<{ ok: true } | Failed>;
  /** Background completion when the Owner navigated away / switched folders before the run succeeded. */
  onBackgroundComplete?: (result: OnboardingRunResult, input: CommitInput | null, runId: string) => Promise<void> | void;
  /** True when the host's `factory.state.updates` subscription is currently live. */
  subscriptionLive?: boolean;
  /** Optional poll interval override (for deterministic unit tests). */
  pollIntervalMs?: number;
  /** Initial run seed (used by SSR / unit tests). */
  initialRun?: OnboardingRun | null;
  /** Initial client open-workspace state seed. */
  initialOpenWorkspace?: OpenWorkspaceState;
  /** Initial poll warning seed. */
  initialPollWarning?: string | null;
  /** Initial start error seed. */
  initialStartError?: string | null;
}

export interface OnboardingRunTracker {
  activeRun: OnboardingRun | null;
  openWorkspace: OpenWorkspaceState;
  starting: boolean;
  startError: string | null;
  pollWarning: string | null;
  runningRuns: readonly OnboardingRun[];
  startRun: (payload: CommitInput) => Promise<void>;
  retryRun: (payload: CommitInput) => Promise<void>;
  probeFolder: (folder: string, aliasFolder?: string) => Promise<OnboardingRun | null>;
  notifyProgress: (projectRoot?: string) => void;
  clearActive: () => void;
}

function addNormalizedFolder(set: Set<string>, folder: string | null | undefined): void {
  if (typeof folder !== "string") return;
  const norm = normalizeFolderPath(folder);
  if (norm !== "") set.add(norm);
}

function collectRunningRuns(map: Map<string, WatchedRun>): OnboardingRun[] {
  const list: OnboardingRun[] = [];
  for (const item of map.values()) {
    if (item.run.status === "running") list.push(item.run);
  }
  return list;
}

function sameRunningSet(prev: readonly OnboardingRun[], next: readonly OnboardingRun[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i]!.runId !== next[i]!.runId || prev[i]!.folder !== next[i]!.folder) return false;
  }
  return true;
}

/**
 * React hook managing async onboarding runs across active wizard steps and
 * background completion if the Owner leaves the onboarding screen or changes folder.
 */
export function useOnboardingRunTracker(options: OnboardingRunTrackerOptions): OnboardingRunTracker {
  const [activeRun, setActiveRun] = useState<OnboardingRun | null>(options.initialRun ?? null);
  const [openWorkspace, setOpenWorkspace] = useState<OpenWorkspaceState>(
    options.initialOpenWorkspace ?? INITIAL_OPEN_WORKSPACE,
  );
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(options.initialStartError ?? null);
  const [pollWarning, setPollWarning] = useState<string | null>(options.initialPollWarning ?? null);
  const [runningRuns, setRunningRuns] = useState<readonly OnboardingRun[]>(() =>
    options.initialRun && options.initialRun.status === "running" ? [options.initialRun] : [],
  );

  const alive = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const activeFolderRef = useRef<string | null>(options.activeFolder);
  activeFolderRef.current = options.activeFolder;
  const prevActiveFolderRef = useRef<string | null>(options.activeFolder);
  const watchedRunsRef = useRef<Map<string, WatchedRun>>(new Map());
  const inFlightFoldersRef = useRef<Set<string>>(new Set());

  if (options.initialRun && options.initialRun.status === "running" && !watchedRunsRef.current.has(options.initialRun.runId)) {
    const folders = new Set<string>();
    addNormalizedFolder(folders, options.initialRun.folder);
    addNormalizedFolder(folders, options.activeFolder);
    watchedRunsRef.current.set(options.initialRun.runId, {
      run: options.initialRun,
      folders,
      commitInput: null,
      pollFailures: 0,
      inFlight: false,
      pendingRefresh: false,
      finalized: false,
    });
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      watchedRunsRef.current.clear();
      inFlightFoldersRef.current.clear();
    };
  }, []);

  const syncRunningList = useCallback(() => {
    if (!alive.current) return;
    const next = collectRunningRuns(watchedRunsRef.current);
    setRunningRuns((prev) => (sameRunningSet(prev, next) ? prev : next));
  }, []);

  const isViewingFolder = useCallback((folder: string): boolean => {
    if (!alive.current || activeFolderRef.current === null) return false;
    const target = normalizeFolderPath(folder);
    return target !== "" && normalizeFolderPath(activeFolderRef.current) === target;
  }, []);

  const isActiveViewFor = useCallback((watched: WatchedRun): boolean => {
    if (!alive.current) return false;
    const currentFolder = activeFolderRef.current;
    if (currentFolder === null) return false;
    const norm = normalizeFolderPath(currentFolder);
    return norm !== "" && watched.folders.has(norm);
  }, []);

  const recordPollFailure = useCallback(
    (watched: WatchedRun): void => {
      watched.pollFailures += 1;
      if (isActiveViewFor(watched) && watched.pollFailures >= TRANSIENT_POLL_WARNING_THRESHOLD) {
        setPollWarning(POLL_WARNING_TEXT);
      }
    },
    [isActiveViewFor],
  );

  const runFinalize = useCallback(
    async (runId: string, result: OnboardingRunResult, commitInput: CommitInput | null): Promise<void> => {
      const watched = watchedRunsRef.current.get(runId);
      if (watched !== undefined) {
        if (watched.finalized) return;
        watched.finalized = true;
      }
      const isActive = (): boolean =>
        watched !== undefined ? isActiveViewFor(watched) : isViewingFolder(result.projectRoot);
      const finalize = optionsRef.current.onActiveComplete;
      const startedAt = new Date().toISOString();
      if (finalize === undefined) {
        if (!alive.current) return;
        setOpenWorkspace({ status: "done", startedAt, finishedAt: startedAt, error: null });
        setStarting(false);
        watchedRunsRef.current.delete(runId);
        syncRunningList();
        return;
      }
      setOpenWorkspace({ status: "running", startedAt, finishedAt: null, error: null });
      setStartError(null);
      setStarting(true);
      try {
        const reply = await finalize(result, commitInput, runId, isActive);
        if (!alive.current) return;
        if (!isActive()) {
          if (watched !== undefined) {
            watchedRunsRef.current.delete(runId);
            syncRunningList();
          }
          return;
        }
        const finishedAt = new Date().toISOString();
        if (reply.ok) {
          setOpenWorkspace({ status: "done", startedAt, finishedAt, error: null });
          setStarting(false);
          watchedRunsRef.current.delete(runId);
          syncRunningList();
        } else {
          if (watched !== undefined) watched.finalized = false;
          setOpenWorkspace({ status: "failed", startedAt, finishedAt, error: reply.error });
          setStartError(reply.error);
          setStarting(false);
        }
      } catch (error) {
        if (!alive.current) return;
        if (watched !== undefined) watched.finalized = false;
        const msg = describeThrown(error);
        if (isActive()) {
          setOpenWorkspace({ status: "failed", startedAt, finishedAt: new Date().toISOString(), error: msg });
          setStartError(msg);
          setStarting(false);
        }
      }
    },
    [isActiveViewFor, isViewingFolder, syncRunningList],
  );

  const registerWatchedRun = useCallback(
    (run: OnboardingRun, commitInput: CommitInput | null, aliasFolder?: string): WatchedRun => {
      const existing = watchedRunsRef.current.get(run.runId);
      if (existing !== undefined) {
        existing.run = run;
        if (commitInput !== null) existing.commitInput = commitInput;
        addNormalizedFolder(existing.folders, run.folder);
        addNormalizedFolder(existing.folders, aliasFolder);
        return existing;
      }
      const folders = new Set<string>();
      addNormalizedFolder(folders, run.folder);
      addNormalizedFolder(folders, commitInput?.folder);
      addNormalizedFolder(folders, aliasFolder);
      const entry: WatchedRun = {
        run,
        folders,
        commitInput,
        pollFailures: 0,
        inFlight: false,
        pendingRefresh: false,
        finalized: false,
      };
      watchedRunsRef.current.set(run.runId, entry);
      return entry;
    },
    [],
  );

  const applyServerRun = useCallback(
    async (nextRun: OnboardingRun, commitInput: CommitInput | null = null, aliasFolder?: string): Promise<void> => {
      if (!alive.current) return;
      const watched = registerWatchedRun(nextRun, commitInput, aliasFolder);
      watched.pollFailures = 0;
      const activeForRun = isActiveViewFor(watched);

      if (activeForRun) {
        setActiveRun(nextRun);
        setPollWarning(null);
      }

      if (nextRun.status === "running") {
        syncRunningList();
        return;
      }

      if (nextRun.status === "failed") {
        syncRunningList();
        if (activeForRun) {
          setStartError(nextRun.error ?? "Onboarding failed");
          setStarting(false);
        } else {
          watchedRunsRef.current.delete(nextRun.runId);
        }
        return;
      }

      // nextRun.status === "succeeded"
      syncRunningList();
      if (nextRun.result === null) {
        if (activeForRun) setStarting(false);
        watchedRunsRef.current.delete(nextRun.runId);
        return;
      }

      if (activeForRun) {
        await runFinalize(nextRun.runId, nextRun.result, watched.commitInput);
      } else if (!watched.finalized) {
        watched.finalized = true;
        watchedRunsRef.current.delete(nextRun.runId);
        syncRunningList();
        await optionsRef.current.onBackgroundComplete?.(nextRun.result, watched.commitInput, nextRun.runId);
      }
    },
    [isActiveViewFor, registerWatchedRun, runFinalize, syncRunningList],
  );

  const refreshWatchedRun = useCallback(
    async (runId: string): Promise<void> => {
      if (!alive.current) return;
      const statusFn = optionsRef.current.status;
      if (statusFn === undefined) return;
      const watched = watchedRunsRef.current.get(runId);
      if (watched === undefined || watched.run.status !== "running") return;
      if (watched.inFlight) {
        watched.pendingRefresh = true;
        return;
      }
      watched.inFlight = true;
      try {
        const reply = await statusFn({ runId });
        if (!alive.current) return;
        if (!reply.ok) {
          recordPollFailure(watched);
          return;
        }
        watched.pollFailures = 0;
        if (isActiveViewFor(watched)) setPollWarning(null);
        if (reply.run !== null) {
          await applyServerRun(reply.run);
        }
      } catch {
        if (!alive.current) return;
        recordPollFailure(watched);
      } finally {
        watched.inFlight = false;
        const current = watchedRunsRef.current.get(runId);
        if (current !== undefined && current.pendingRefresh) {
          current.pendingRefresh = false;
          if (alive.current && current.run.status === "running") {
            void refreshWatchedRun(runId);
          }
        }
      }
    },
    [applyServerRun, isActiveViewFor, recordPollFailure],
  );

  // Sync UI state when switching activeFolder (keep running background watchers alive!).
  useEffect(() => {
    const prev = prevActiveFolderRef.current;
    prevActiveFolderRef.current = options.activeFolder;
    if (normalizeFolderPath(prev ?? "") === normalizeFolderPath(options.activeFolder ?? "")) return;

    const norm = options.activeFolder === null ? "" : normalizeFolderPath(options.activeFolder);
    let matched: WatchedRun | undefined;
    for (const [id, entry] of watchedRunsRef.current.entries()) {
      if (norm !== "" && entry.folders.has(norm) && entry.run.status === "running") {
        matched = entry;
      } else if (entry.run.status !== "running") {
        watchedRunsRef.current.delete(id);
      }
    }

    if (matched !== undefined) {
      setActiveRun(matched.run);
      setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
      setStarting(true);
      setStartError(null);
      setPollWarning(matched.pollFailures >= TRANSIENT_POLL_WARNING_THRESHOLD ? POLL_WARNING_TEXT : null);
    } else {
      setActiveRun(null);
      setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
      setStarting(false);
      setStartError(null);
      setPollWarning(null);
    }
    syncRunningList();
  }, [options.activeFolder, syncRunningList]);

  // Bounded status polling while any tracked run is `running`.
  useEffect(() => {
    if (runningRuns.length === 0 || options.status === undefined) return;
    const intervalMs = options.pollIntervalMs ?? (options.subscriptionLive ? LIVE_BACKSTOP_POLL_MS : DEFAULT_POLL_MS);
    const id = setInterval(() => {
      for (const entry of watchedRunsRef.current.values()) {
        if (entry.run.status === "running") {
          void refreshWatchedRun(entry.run.runId);
        }
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [runningRuns, options.pollIntervalMs, options.subscriptionLive, options.status !== undefined, refreshWatchedRun]);

  const startRun = useCallback(
    async (payload: CommitInput): Promise<void> => {
      const lockKey = normalizeFolderPath(payload.folder) || "__default__";
      if (inFlightFoldersRef.current.has(lockKey)) return;
      inFlightFoldersRef.current.add(lockKey);
      setStarting(true);
      setStartError(null);
      setPollWarning(null);
      setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
      try {
        const reply = await optionsRef.current.start(payload);
        if (!alive.current) return;
        if (!reply.ok) {
          if (isViewingFolder(payload.folder)) {
            setStartError(reply.error);
            setStarting(false);
          }
          return;
        }
        if (reply.run !== undefined) {
          await applyServerRun(reply.run, payload, payload.folder);
        } else if (isViewingFolder(payload.folder)) {
          setStarting(false);
        }
      } catch (error) {
        if (!alive.current) return;
        if (isViewingFolder(payload.folder)) {
          setStartError(describeThrown(error));
          setStarting(false);
        }
      } finally {
        inFlightFoldersRef.current.delete(lockKey);
      }
    },
    [applyServerRun, isViewingFolder],
  );

  const retryRun = useCallback(
    async (payload: CommitInput): Promise<void> => {
      if (activeRun !== null && activeRun.status === "succeeded" && openWorkspace.status === "failed" && activeRun.result !== null) {
        const lockKey = normalizeFolderPath(payload.folder || activeRun.folder) || "__default__";
        if (inFlightFoldersRef.current.has(lockKey)) return;
        inFlightFoldersRef.current.add(lockKey);
        try {
          await runFinalize(activeRun.runId, activeRun.result, payload);
        } finally {
          inFlightFoldersRef.current.delete(lockKey);
        }
        return;
      }
      await startRun(payload);
    },
    [activeRun, openWorkspace.status, runFinalize, startRun],
  );

  const probeFolder = useCallback(
    async (folder: string, aliasFolder?: string): Promise<OnboardingRun | null> => {
      const statusFn = optionsRef.current.status;
      if (statusFn === undefined) return null;
      const trimmed = folder.trim();
      if (trimmed === "") return null;
      try {
        const reply = await statusFn({ folder: trimmed });
        if (!alive.current || !reply.ok || reply.run === null) return null;
        if (reply.run.status !== "running") return null;
        await applyServerRun(reply.run, null, aliasFolder ?? trimmed);
        return reply.run;
      } catch {
        return null;
      }
    },
    [applyServerRun],
  );

  const notifyProgress = useCallback(
    (projectRoot?: string): void => {
      const targetNorm = typeof projectRoot === "string" ? normalizeFolderPath(projectRoot) : "";
      for (const entry of watchedRunsRef.current.values()) {
        if (entry.run.status !== "running") continue;
        if (targetNorm === "" || entry.folders.has(targetNorm)) {
          void refreshWatchedRun(entry.run.runId);
        }
      }
    },
    [refreshWatchedRun],
  );

  const clearActive = useCallback((): void => {
    const currentFolder = activeFolderRef.current;
    if (currentFolder !== null) {
      const norm = normalizeFolderPath(currentFolder);
      for (const [id, entry] of watchedRunsRef.current.entries()) {
        if (entry.run.status !== "running" && entry.folders.has(norm)) {
          watchedRunsRef.current.delete(id);
        }
      }
    }
    setActiveRun(null);
    setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
    setStarting(false);
    setStartError(null);
    setPollWarning(null);
    syncRunningList();
  }, [syncRunningList]);

  return {
    activeRun,
    openWorkspace,
    starting,
    startError,
    pollWarning,
    runningRuns,
    startRun,
    retryRun,
    probeFolder,
    notifyProgress,
    clearActive,
  };
}

/**
 * Mounts a single `factory.state.updates` subscription for an in-flight
 * onboarding run (`>= 0.16.0` hosts) and notifies the tracker immediately on
 * `onboarding.progress` events. Degrades cleanly on `< 0.16.0` hosts.
 */
export function OnboardingRunSubscriber({
  projectRoot,
  onProgress,
  onLiveChange,
}: {
  projectRoot: string;
  onProgress: (projectRoot: string) => void;
  onLiveChange?: (live: boolean) => void;
}) {
  const input = useMemo(() => ({ projectRoot }), [projectRoot]);
  const sub = useClientSubscription(stateUpdates, input, (event) => {
    if (event.reasons.includes("onboarding.progress")) {
      onProgress(projectRoot);
    }
  });
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  const live = isSubscriptionLive(sub);
  useEffect(() => {
    onLiveChangeRef.current?.(live);
    return () => {
      onLiveChangeRef.current?.(false);
    };
  }, [live]);
  return null;
}
