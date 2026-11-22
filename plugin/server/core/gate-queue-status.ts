/**
 * Shared persisted Gate-queue reader and CLI `factory status` formatter (ADR 0068).
 * Kept dependency-light so `scripts/generate-policies.mjs` compiles it cleanly
 * into `plugin/bin/gate-queue-status.mjs` while `plugin/server/gate-queue.ts`
 * reuses the exact same persisted schema and reader.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PeerHandoffFields } from "./events.ts";

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
  logPath?: string;
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

export interface GateQueueSnapshot {
  paused: boolean;
  pausedAt?: string;
  concurrency: number;
  running: GateQueueItem[];
  queued: GateQueueItem[];
}

export function normalizeGateQueueConcurrency(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return fallback;
  return value;
}

export function cloneGateQueueItem(item: GateQueueItem): GateQueueItem {
  return {
    ...item,
    ...(item.handoff === undefined ? {} : { handoff: { ...item.handoff } }),
  };
}

export function isValidPersistedGateQueueItem(raw: unknown): raw is GateQueueItem {
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

/** Reads `<stateDir>/gate-queue.json` safely; returns `undefined` if missing or invalid. */
export function readPersistedGateQueue(path: string, fallbackConcurrency = 1): GateQueueFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const paused = obj.paused === true;
  const pausedAt = paused && typeof obj.pausedAt === "string" ? obj.pausedAt : undefined;
  const concurrency = normalizeGateQueueConcurrency(obj.concurrency, fallbackConcurrency);
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems.filter(isValidPersistedGateQueueItem).map((item) => cloneGateQueueItem(item));
  return {
    schemaVersion: GATE_QUEUE_SCHEMA_VERSION,
    paused,
    ...(pausedAt === undefined ? {} : { pausedAt }),
    concurrency,
    items,
  };
}

export function snapshotFromGateQueueFile(file: GateQueueFile): GateQueueSnapshot {
  const running = file.items.filter((item) => item.status === "running").map(cloneGateQueueItem);
  const queued = file.items.filter((item) => item.status === "queued").map(cloneGateQueueItem);
  return {
    paused: file.paused,
    ...(file.pausedAt === undefined ? {} : { pausedAt: file.pausedAt }),
    concurrency: file.concurrency,
    running,
    queued,
  };
}

export function formatQueueDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins}m${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${String(remMins).padStart(2, "0")}m`;
}

/**
 * Formats the `Gate queue` section for `factory status` straight from
 * `<stateDir>/gate-queue.json`. Returns `[]` when unpaused and empty so
 * idle status output stays concise.
 */
export function statusGateQueueLines(stateDir: string, now = Date.now()): string[] {
  const file = readPersistedGateQueue(join(stateDir, GATE_QUEUE_FILENAME), 1);
  if (file === undefined) return [];
  const snap = snapshotFromGateQueueFile(file);
  if (!snap.paused && snap.running.length === 0 && snap.queued.length === 0) return [];

  const lines: string[] = [
    "Gate queue",
    `  state: ${snap.paused ? `paused${snap.pausedAt ? ` (since ${snap.pausedAt})` : ""}` : "active"} · concurrency=${snap.concurrency} · running=${snap.running.length} · queued=${snap.queued.length}`,
  ];

  const ordered = [...snap.running, ...snap.queued];
  for (let i = 0; i < ordered.length; i += 1) {
    const item = ordered[i]!;
    const pos = i + 1;
    const mech = item.mechanical ? ` (${item.mechanical})` : "";
    if (item.status === "running") {
      const startedMs = item.startedAt ? Date.parse(item.startedAt) : Date.parse(item.enqueuedAt);
      const elapsed = formatQueueDuration(Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0);
      lines.push(`  #${pos} [running] ${item.projectSlug} · ${item.task} attempt #${item.attempt} · elapsed ${elapsed}${mech}`);
    } else {
      const enqueuedMs = Date.parse(item.enqueuedAt);
      const wait = formatQueueDuration(Number.isFinite(enqueuedMs) ? Math.max(0, now - enqueuedMs) : 0);
      lines.push(`  #${pos} [queued] ${item.projectSlug} · ${item.task} attempt #${item.attempt} · waiting ${wait}${mech}`);
    }
  }

  return lines;
}
