import type { LedgerEvent, ContractSet } from "./events.ts";
import { scopeCoversFile, normalizeScopePath } from "./scope-policy.ts";
type WorkspaceRelation = "equal" | "inside" | "contains";
export function liveWorkspaceConflict(
  ledger: { events: readonly LedgerEvent[] },
  workspace: string,
  task: string,
  myScope?: string[],
): { task: string; workspace: string; relation: WorkspaceRelation; overlapping?: string } | undefined {
  const mine = normalized(workspace);
  const accepted = acceptedTasks(ledger);
  const latestContracts = new Map<string, ContractSet>();
  for (const evt of ledger.events) {
    if (evt.event === "contract_set" && evt.task !== task && !accepted.has(evt.task)) {
      latestContracts.set(evt.task, evt);
    }
  }
  for (const evt of latestContracts.values()) {
    const theirs = normalized(evt.workspace);
    let relation: WorkspaceRelation | undefined;
    if (mine === theirs) relation = "equal";
    else if (mine.startsWith(`${theirs}/`)) relation = "inside";
    else if (theirs.startsWith(`${mine}/`)) relation = "contains";
    if (relation === undefined) continue;
    if (relation === "equal") {
      const overlap = scopesOverlap(myScope, evt.scope);
      if (overlap === undefined) continue; // the worktree exemption — disjoint scopes, one Project
      return { task: evt.task, workspace: evt.workspace, relation, overlapping: overlap };
    }
    return { task: evt.task, workspace: evt.workspace, relation };
  }
  return undefined;
}

/**
 * The first pair of scope prefixes that overlap (either covers the other's
 * territory), or undefined when the scopes are disjoint — the exemption's
 * one question. Unrestricted (empty/undefined) scope means "everywhere", so
 * it overlaps everything and never rides the exemption.
 */
function scopesOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): string | undefined {
  if (a === undefined || a.length === 0 || b === undefined || b.length === 0) return "one contract is unscoped";
  for (const mine of a) {
    for (const theirs of b) {
      if (scopeCoversFile([mine], theirs) || scopeCoversFile([theirs], mine)) return `${mine} ↔ ${theirs}`;
      const minePath = normalizeScopePath(mine);
      const theirPath = normalizeScopePath(theirs);
      const mineWildcard = minePath.search(/[*?]/);
      const theirWildcard = theirPath.search(/[*?]/);
      if (mineWildcard < 0 && theirWildcard < 0) continue;
      // A glob's static prefix reserves its possible territory conservatively:
      // a partial filename prefix may overlap a different glob or directory.
      const minePrefix = mineWildcard < 0 ? `${minePath}/` : minePath.slice(0, mineWildcard);
      const theirPrefix = theirWildcard < 0 ? `${theirPath}/` : theirPath.slice(0, theirWildcard);
      if (minePrefix.startsWith(theirPrefix) || theirPrefix.startsWith(minePrefix)) return `${mine} ↔ ${theirs}`;
    }
  }
  return undefined;
}

/** Workspace paths as contracted, with a tolerated trailing slash gone. */
export function normalized(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function acceptedTasks(ledger: { events: readonly LedgerEvent[] }): Set<string> {
  const accepted = new Set<string>();
  for (const event of ledger.events) if (event.event === "attempt_accepted") {
    if (event.landing === "pending-conflict") accepted.delete(event.task); else accepted.add(event.task);
  }
  return accepted;
}
