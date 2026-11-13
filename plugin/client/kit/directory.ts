/**
 * The seat-directory starter's pure halves (v0.6.1 W4 spike, ADR 0057 §8/§11):
 * the plan builders that turn one `factory.seats.directory` answer into the
 * header-button and composer-pill registrations the client owes Paseo, and
 * the registration reconcile — paseo-room's role-pill pattern: a map of
 * registrations, `update` on change, `remove` on disappearance. Zero React
 * Native runtime imports so Node unit tests exercise the law directly (the
 * live-seats.ts precedent); the starter and popover live in
 * factory/directory.tsx.
 */
import type { ProjectDirectoryEntry, SeatDirectoryEntry } from "../../shared/view.ts";

/** The header button's contribution id — `factory-header-<workspaceId>` (the spike's E2E hook). */
export const headerButtonId = (workspaceId: string): string => `factory-header-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/** The composer pill's contribution id — `factory-pill-<agentId>` (the spike's E2E hook). */
export const pillId = (agentId: string): string => `factory-pill-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/** The header label — "Factory" alone when nothing needs the Owner, "Factory · N" when N things do. */
export function headerLabel(needsYouCount: number): string {
  return needsYouCount > 0 ? `Factory · ${needsYouCount}` : "Factory";
}

/** What one registration-reconcile step needs: the button's id, its label, and what changed. */
export interface DirectoryPlan {
  readonly id: string;
  readonly label: string;
  /** Everything about the plan that must refresh the registration when it changes (the label alone rarely does). */
  readonly fingerprint: string;
}

/** One header-button plan — a Project root workspace with its Needs-you count. */
export interface HeaderButtonPlan extends DirectoryPlan {
  readonly workspaceId: string;
}

/** One composer-pill plan — a live seat agent with its whole directory row (the popover's data). */
export interface PillPlan extends DirectoryPlan {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly seat: SeatDirectoryEntry;
}

/** The header-button plans one directory answer implies — one per Project root workspace that reports one. */
export function headerPlans(projects: readonly ProjectDirectoryEntry[]): HeaderButtonPlan[] {
  const plans: HeaderButtonPlan[] = [];
  for (const project of projects) {
    if (typeof project.workspaceId !== "string" || project.workspaceId === "") continue; // nothing to anchor the button to
    const label = headerLabel(project.needsYouCount);
    plans.push({ id: headerButtonId(project.workspaceId), workspaceId: project.workspaceId, label, fingerprint: label });
  }
  return plans;
}

/** The composer-pill plans one directory answer implies — one per live seat agent that reports a workspace. */
export function pillPlans(seats: readonly SeatDirectoryEntry[]): PillPlan[] {
  const plans: PillPlan[] = [];
  for (const seat of seats) {
    if (typeof seat.workspaceId !== "string" || seat.workspaceId === "") continue; // a pill needs a workspace to sit in
    plans.push({
      id: pillId(seat.agentId),
      workspaceId: seat.workspaceId,
      agentId: seat.agentId,
      label: seat.role,
      seat,
      fingerprint: JSON.stringify(seat),
    });
  }
  return plans;
}

/** The registration handle the reconcile drives — Paseo's PluginButtonRegistration shape, generic over the update patch. */
export interface RegistrationLike<Patch = { label?: string }> {
  update(patch: Patch): void;
  remove(): void;
}

/**
 * Keeps one registration map in step with a directory answer: what appeared
 * registers, what changed updates in place, what disappeared is removed.
 * `fingerprint` decides "changed" — the label for header buttons, the whole
 * seat row for pills (a model or context change refreshes the popover).
 */
export function reconcileDirectory<T extends DirectoryPlan, Patch>(
  current: Map<string, { fingerprint: string; registration: RegistrationLike<Patch> }>,
  next: readonly T[],
  register: (plan: T) => RegistrationLike<Patch>,
  refresh: (registration: RegistrationLike<Patch>, plan: T) => void,
): void {
  const seen = new Set<string>();
  for (const plan of next) {
    seen.add(plan.id);
    const prior = current.get(plan.id);
    if (prior === undefined) {
      current.set(plan.id, { fingerprint: plan.fingerprint, registration: register(plan) });
    } else if (prior.fingerprint !== plan.fingerprint) {
      refresh(prior.registration, plan);
      prior.fingerprint = plan.fingerprint;
    }
  }
  for (const [id, entry] of current) {
    if (seen.has(id)) continue;
    entry.registration.remove();
    current.delete(id);
  }
}
