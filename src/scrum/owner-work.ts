/** Owner decisions and finite allowances projected by the existing run journal. */
import { FactoryError } from '../errors.ts';
import type { ScrumRun, RunPhase } from './run-journal.ts';
import { trackKind } from './tracks.ts';
import { safeId } from './types.ts';
import type { ScrumRoleName } from './types.ts';
export type AllowanceDimension = 'tasks' | 'qaFixRounds';
export interface RunBlocker {
  id: string;
  reason: string;
  causes: (AllowanceDimension | 'elapsed' | 'other' | 'ambiguous')[];
}
export interface OwnerDependency { kind: 'task' | 'stage'; id: string }
export interface OwnerRequest {
  id: string;
  kind: 'question' | 'design';
  question: string;
  affected: OwnerDependency[];
  origin: { actor: string; role: string };
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: string;
  design?: { revision: number; digest: string };
  resolution?: { actor: string; outcome: string; rationale: string; requestId: string };
}
export interface OwnerGrant {
  requestId: string;
  actor: string;
  dimension: AllowanceDimension;
  amount: number;
  rationale: string;
}
export const OWNER_STAGES = ['planning', 'design', 'readiness', 'implementation', 'qa', 'fixing'] as const;
export function validateOwnerRequest(request: OwnerRequest): void {
  if (!request || !safeId(request.id) || request.kind !== 'question' || typeof request.question !== 'string' || !request.question.trim() ||
      !request.origin || !request.origin.actor?.trim() || !['owner', 'lead', 'supervisor'].includes(request.origin.role) ||
      request.status !== 'pending' || request.resolution !== undefined || request.design !== undefined ||
      !Array.isArray(request.affected) || !request.affected.length || request.affected.some(d => !d ||
        (d.kind === 'task' ? !safeId(d.id) : d.kind !== 'stage' || !OWNER_STAGES.includes(d.id as typeof OWNER_STAGES[number]))))
    throw new FactoryError('invalid-owner-request', 'Question, origin and explicit Task/stage dependencies required');
}
const roleStage: Record<ScrumRoleName, string> = { pm: 'planning', ux: 'design', architect: 'design', dev: 'implementation', qa: 'qa' };
export function ownerDependencyHolds(run: ScrumRun, work: { task?: string; role?: ScrumRoleName; stage?: string }): OwnerRequest[] {
  const stages = [work.stage ?? (work.role ? roleStage[work.role] : undefined)];
  if (work.task && run.fixReservations.some(r => r.task === work.task)) stages.push('fixing');
  return (run.ownerRequests ?? []).filter(request => request.status !== 'answered' && (request.kind === 'question' || request.status === 'pending') && request.affected.some(d =>
    d.kind === 'task' ? d.id === work.task : stages.includes(d.id)));
}
export function assertOwnerDependencies(run: ScrumRun, work: { task?: string; role?: ScrumRoleName; stage?: string }): void {
  const holds = ownerDependencyHolds(run, work);
  if (holds.length) throw new FactoryError('scrum-owner-answer-required', holds.map(r => `${r.id}: ${r.question} (${r.status}; holds ${r.affected.map(d => `${d.kind} ${d.id}`).join(', ')})`).join('; '));
}
export function deriveRunPhase(run: ScrumRun): RunPhase {
  if (run.blockers.length || run.cancellation) return 'blocked';
  if (run.design?.decision === 'changes_requested') return 'design';
  if (run.design && !run.design.decision) return 'awaiting-ui-approval';
  if (run.readiness) {
    if (run.readiness.contradictions.length || run.readiness.unsafeAssumptions.length || run.readiness.missingCoverage.length) return 'blocked';
    if (trackKind(run.track) === 'ui' && !['approved', 'waived'].includes(run.design?.decision ?? '')) return 'awaiting-ui-approval';
    if (run.qaResult?.status === 'defects_found') return 'qa';
    return 'implementation';
  }
  return run.tasks.some(t => ['ux', 'architect'].includes(t.role)) ? 'design' : 'planning';
}
export function recordRunBlocker(run: ScrumRun, input: { requestId: string; reason: string; cause?: AllowanceDimension }, now: number, legacy = false): void {
  const details = run.blockerDetails ??= [];
  let causes: RunBlocker['causes'] = [input.cause ?? 'other'];
  // The old writer emitted this exact diagnostic with an :exhausted receipt.
  // Diagnose against consumption and elapsed accounting at that historical event.
  if (legacy && !input.cause && input.reason === 'Task/time budget exhausted') {
    causes = [];
    if (input.requestId.endsWith(':exhausted')) {
      if (run.tasks.length >= run.budgets.maxTasks) causes.push('tasks');
      if (typeof run.budgets.maxElapsedMs === 'number' && now - Date.parse(run.createdAt) >= run.budgets.maxElapsedMs) causes.push('elapsed');
    }
    if (!causes.length) causes.push('ambiguous');
  } else if (legacy && !input.cause && input.reason === 'qa-fix-budget-exhausted: escalate to Supervisor' && input.requestId.endsWith(':exhausted')) causes = ['qaFixRounds'];
  details.push({ id: input.requestId, reason: input.reason, causes });
  run.blockers.push(input.reason);
  run.phase = 'blocked';
}
function reconcileBlockers(run: ScrumRun, remove: (cause: RunBlocker['causes'][number]) => boolean): void {
  const details = run.blockerDetails ?? [];
  // Only registered causes are removable. Unknown legacy strings stay held.
  run.blockerDetails = details.flatMap(blocker => {
    const causes = blocker.causes.filter(cause => !remove(cause));
    if (!causes.length) return [];
    if (causes.length === blocker.causes.length) return [blocker];
    return [{ ...blocker, causes, reason: causes.includes('tasks') ? `Task capacity exhausted: ${run.tasks.length}/${run.budgets.maxTasks} Tasks used. Ask Owner to add Task capacity.` : blocker.reason }];
  });
  const unregistered = [...run.blockers];
  for (const blocker of details) {
    const index = unregistered.indexOf(blocker.reason);
    if (index !== -1) unregistered.splice(index, 1);
  }
  run.blockers = [...unregistered, ...run.blockerDetails.map(b => b.reason)];
  if (run.phase === 'blocked') run.phase = deriveRunPhase(run);
}
export function applyOwnerGrant(run: ScrumRun, grant: OwnerGrant): void {
  const key = grant.dimension === 'tasks' ? 'maxTasks' : 'maxQaFixRounds';
  if (!['tasks', 'qaFixRounds'].includes(grant.dimension) || typeof grant.actor !== 'string' || !grant.actor.trim() ||
      !Number.isSafeInteger(grant.amount) || grant.amount <= 0 || grant.dimension === 'qaFixRounds' && grant.amount !== 1 ||
      typeof grant.rationale !== 'string' || !grant.rationale.trim() || !Number.isSafeInteger(run.budgets[key] + grant.amount))
    throw new FactoryError('invalid-owner-grant', 'Positive safe integer capacity, authenticated actor and nonempty rationale required; QA grants add exactly one round');
  run.budgets[key] += grant.amount;
  (run.allowanceGrants ??= []).push(grant);
  reconcileBlockers(run, cause => cause === grant.dimension && (cause === 'tasks' ? run.tasks.length < run.budgets.maxTasks : run.fixRounds < run.budgets.maxQaFixRounds));
}
export function continueLegacyElapsed(run: ScrumRun): void {
  if (!(run.blockerDetails ?? []).some(b => b.causes.includes('elapsed')))
    throw new FactoryError('scrum-continuation-held', 'No proven legacy elapsed-time blocker. Inspect blocker provenance; Task/QA capacity and unrelated holds require their own resolution.');
  reconcileBlockers(run, cause => cause === 'elapsed');
}
export function designRequestId(run: ScrumRun): string {
  return `design:${run.runId}:${run.design!.revision}:${run.design!.digest}`;
}
export function ensureDesignRequest(run: ScrumRun, now: number): OwnerRequest | undefined {
  if (!run.design || run.design.decision) return undefined;
  const requests = run.ownerRequests ??= [];
  const id = designRequestId(run);
  let request = requests.find(r => r.id === id);
  if (!request) {
    request = { id, kind: 'design', question: `Review UI design r${run.design.revision}`, affected: [{ kind: 'stage', id: 'implementation' }], origin: { actor: 'lead', role: 'lead' }, status: 'pending', createdAt: new Date(now).toISOString(), design: { revision: run.design.revision, digest: run.design.digest } };
    requests.push(request);
  }
  return request;
}
