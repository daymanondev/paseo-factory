import type { ScrumHarnessIdentity } from "./scrum/harness.ts";
/**
 * Unforgeable Correlation token registry (v0.0.26, ADR 0016 §1):
 * Issues a session-scoped `cor_<uuid>` token during `agent.create`, associates
 * it with the live `agentId` on `agent.session_open`, and persists the mapping
 * in `<stateDir>/correlations.json` so both the plugin in-process hooks and
 * external `bridge.mjs` / `factory` CLI processes can authenticate a caller's
 * seat (`supervisor`, `lead`, `agent`), owning `Project`, and bound `Task`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SeatCorrelationRole = "supervisor" | "lead" | "agent";

export interface SeatCorrelationRecord {
  execution?: ScrumHarnessIdentity;
  correlationId: string;
  role: SeatCorrelationRole;
  projectSlug: string;
  projectRoot: string;
  task?: string;
  agentId?: string;
  issuedAt: string;
}

export function correlationsPathFor(stateDir: string): string {
  return join(stateDir, "correlations.json");
}

function isValidRole(value: unknown): value is SeatCorrelationRole {
  return value === "supervisor" || value === "lead" || value === "agent";
}

function isValidRecord(value: unknown): value is SeatCorrelationRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.correlationId !== "string" || r.correlationId.trim() === "") return false;
  if (!isValidRole(r.role)) return false;
  if (typeof r.projectSlug !== "string" || r.projectSlug.trim() === "") return false;
  if (typeof r.projectRoot !== "string" || r.projectRoot.trim() === "") return false;
  if (r.task !== undefined && (typeof r.task !== "string" || r.task.trim() === "")) return false;
  if (r.agentId !== undefined && (typeof r.agentId !== "string" || r.agentId.trim() === "")) return false;
  if (typeof r.issuedAt !== "string" || r.issuedAt.trim() === "") return false;
  return true;
}

export function readCorrelations(stateDir: string): SeatCorrelationRecord[] {
  const path = correlationsPathFor(stateDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rawList = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { records?: unknown }).records)
        ? (parsed as { records: unknown[] }).records
        : [];
    return rawList.filter(isValidRecord);
  } catch {
    return [];
  }
}

function writeCorrelationsAtomic(stateDir: string, records: readonly SeatCorrelationRecord[]): void {
  const path = correlationsPathFor(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
  renameSync(tmp, path);
}

export class CorrelationRegistry {
  readonly stateDir: string;
  private readonly byCorrelationId = new Map<string, SeatCorrelationRecord>();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.reloadFromDisk();
  }

  private reloadFromDisk(): void {
    this.byCorrelationId.clear();
    for (const rec of readCorrelations(this.stateDir)) this.byCorrelationId.set(rec.correlationId, rec);
  }

  private persistToDisk(): void {
    writeCorrelationsAtomic(this.stateDir, [...this.byCorrelationId.values()]);
  }

  issue(
    input: Omit<SeatCorrelationRecord, "correlationId" | "issuedAt"> & {
      correlationId?: string;
      issuedAt?: string;
    },
  ): SeatCorrelationRecord {
    this.reloadFromDisk();
    const correlationId =
      typeof input.correlationId === "string" && input.correlationId.trim() !== ""
        ? input.correlationId.trim()
        : `cor_${randomUUID()}`;
    const issuedAt =
      typeof input.issuedAt === "string" && input.issuedAt.trim() !== ""
        ? input.issuedAt.trim()
        : new Date().toISOString();
    const record: SeatCorrelationRecord = {
      correlationId,
      ...(input.execution === undefined ? {} : { execution: structuredClone(input.execution) }),
      role: input.role,
      projectSlug: input.projectSlug,
      projectRoot: input.projectRoot,
      ...(typeof input.task === "string" && input.task.trim() !== "" ? { task: input.task.trim() } : {}),
      ...(typeof input.agentId === "string" && input.agentId.trim() !== "" ? { agentId: input.agentId.trim() } : {}),
      issuedAt,
    };
    this.byCorrelationId.set(correlationId, record);
    this.persistToDisk();
    return record;
  }

  associate(correlationId: string, agentId: string): SeatCorrelationRecord | undefined {
    const trimmedCorr = correlationId.trim();
    const trimmedAgent = agentId.trim();
    if (trimmedCorr === "" || trimmedAgent === "") return undefined;
    this.reloadFromDisk();
    const existing = this.byCorrelationId.get(trimmedCorr);
    if (existing === undefined) return undefined;
    const updated: SeatCorrelationRecord = { ...existing, agentId: trimmedAgent };
    this.byCorrelationId.set(trimmedCorr, updated);
    this.persistToDisk();
    return updated;
  }

  resolve(correlationIdOrAgentId: string): SeatCorrelationRecord | undefined {
    const key = typeof correlationIdOrAgentId === "string" ? correlationIdOrAgentId.trim() : "";
    if (key === "") return undefined;
    this.reloadFromDisk();
    const byCorr = this.byCorrelationId.get(key);
    if (byCorr !== undefined) return byCorr;
    let matched: SeatCorrelationRecord | undefined;
    for (const rec of this.byCorrelationId.values()) {
      if (rec.agentId === key) {
        matched = rec;
      }
    }
    return matched;
  }

  findByAgentId(agentId: string): SeatCorrelationRecord | undefined {
    return this.resolve(agentId);
  }

  list(): SeatCorrelationRecord[] {
    this.reloadFromDisk();
    return [...this.byCorrelationId.values()];
  }

  /**
   * Purge all correlation records belonging to `projectSlug`, `projectRoot`,
   * the project's managed `<stateDir>/projects/<slug>/worktrees/` tree, or any
   * of `tasks` (v0.0.35, ADR 0024).
   */
  purgeProject(projectSlug: string, projectRoot?: string, tasks?: Iterable<string>, keepSeats = false): number {
    this.reloadFromDisk();
    const taskSet = new Set(tasks ?? []);
    const cleanRoot = typeof projectRoot === "string" && projectRoot.trim() !== "" ? projectRoot.trim().replace(/\/+$/, "") : undefined;
    const worktreesPrefix = `${join(this.stateDir, "projects", projectSlug, "worktrees").replace(/\/+$/, "")}/`;
    let removed = 0;
    for (const [key, rec] of this.byCorrelationId.entries()) {
      const recRoot = rec.projectRoot.replace(/\/+$/, "");
      const matchesRoot =
        cleanRoot !== undefined && (recRoot === cleanRoot || recRoot.startsWith(`${cleanRoot}/`));
      const matchesWorktree = recRoot.startsWith(worktreesPrefix);
      const matchesTask = rec.task !== undefined && taskSet.has(rec.task);
      if ((rec.projectSlug === projectSlug || matchesRoot || matchesWorktree || matchesTask) && (!keepSeats || rec.role === "agent" || matchesTask)) {
        this.byCorrelationId.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      writeCorrelationsAtomic(this.stateDir, [...this.byCorrelationId.values()]);
    }
    return removed;
  }
}
