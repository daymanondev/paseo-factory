/** Scrum directive admission is local to the mode; the mailbox serializes ingress. */
import type { Factory } from "./core/factory.ts";
import { FactoryError } from "./core/errors.ts";
import { sha256 } from "./core/scrum/artifacts.ts";
import { listRuns, readRun, terminalRun } from "./core/scrum/run-journal.ts";
import { scrumOperation } from "./core/scrum/controller.ts";
export interface ScrumDirective {
  runId?: string;
  scrum?: {
    initiativeId?: string;
    track?: import("./core/scrum/run-journal.ts").RunTrack;
    rationale?: string;
    ownedPaths?: string[];
    budgets?: Partial<import("./core/scrum/run-journal.ts").RunBudgets>;
  };
}
export function bindScrumDirective(
  factory: Factory,
  root: string,
  slug: string,
  request: ScrumDirective & { id: string; message: string },
): {
  execution?: { mode: "scrum"; runId: string; configRevision: number };
  packet?: string;
} {
  const active = listRuns(factory.stateDir, slug).filter(r => !terminalRun(r) && !r.cancellation).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const runId = request.runId ?? (request.scrum ? `run-${request.id}` : active?.runId ?? `run-${request.id}`);
  const admit = request.scrum !== undefined || (!request.runId && !active);
  const slugPart = request.message.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 45) || "initiative";
  const initiativeId = request.scrum?.initiativeId ?? `scrum-${slugPart}-${sha256(request.id).slice(0, 10)}`;
  const admission = {
    initiativeId, track: "standard", rationale: request.message.trim().slice(0, 500),
    ownedPaths: ["prd.md", "ux-spec.md", "architecture.md", "release-bundle.json"].map(p => `.scratch/${initiativeId}/${p}`),
    ...request.scrum,
  };
  let run: import("./core/scrum/run-journal.ts").ScrumRun;
  if (admit) {
    // create is implemented by the same writer-owned controller as CLI/RPC.
    run = scrumOperation(
      {
        operation: "run.create",
        runId,
        requestId: `${request.id}:admit`,
        payload: admission,
      },
      {
        factory,
        slug,
        root,
        authority: "supervisor",
        actor: "supervisor",
        activeAgents: [],
        pendingDirectives: false,
      },
    ) as typeof run;
  } else run = readRun(factory.stateDir, slug, runId);
  if (terminalRun(run) || run.cancellation)
    throw new FactoryError("scrum-run-terminal", run.phase);
  return {
    execution: { mode: "scrum", runId, configRevision: run.configRevision },
    packet: `# Frozen Scrum run\n${JSON.stringify(run)}\n`,
  };
}
