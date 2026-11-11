/**
 * The onboarding wizard's pure state machine (v0.6.0 W7, ADR 0056): which of
 * the four steps (Folder → Prerequisites → Models → Start) the Owner is on and
 * everything they have entered. It holds no RPC state and draws nothing — the
 * wizard component owns those — so "back without losing input" and "may this
 * step advance" are plain functions a test can drive. Function-style only; no
 * class syntax reaches the Hermes bundle.
 */
import type { z } from "zod";
import type { onboardingCommit, onboardingInspect } from "../../shared/rpc.ts";
import type { Lanes } from "../../shared/view.ts";

export const ONBOARDING_STEPS = ["Folder", "Prerequisites", "Models", "Start"] as const;
export type OnboardingStep = 1 | 2 | 3 | 4;

/** What the folder-inspection RPC answers when it can answer. */
export type Inspection = Extract<z.output<typeof onboardingInspect.output>, { ok: true }>;
export type CommitInput = z.input<typeof onboardingCommit.input>;

/** The three seats the Project starts on — the only lanes step 3 offers. */
export type OnboardingLaneName = "supervisor" | "lead" | "worker";
export const ONBOARDING_LANES: readonly OnboardingLaneName[] = ["supervisor", "lead", "worker"];

export interface DesignChoice {
  projectId: string;
  projectName: string;
}

/** Everything the Owner has entered — kept across Back and Next. */
export interface WizardInput {
  step: OnboardingStep;
  /** The Owner accepted initialising Git for a folder that is not a repository. */
  initGit: boolean;
  lanes: Record<OnboardingLaneName, string>;
  directive: string;
  design: DesignChoice | null;
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "initGit"; value: boolean }
  | { type: "lane"; lane: OnboardingLaneName; value: string }
  | { type: "directive"; value: string }
  | { type: "design"; design: DesignChoice | null };

/** Step 3 is prefilled from the machine defaults. */
export function initialWizard(machineLanes: Pick<Lanes, OnboardingLaneName>): WizardInput {
  return {
    step: 1,
    initGit: false,
    lanes: { supervisor: machineLanes.supervisor, lead: machineLanes.lead, worker: machineLanes.worker },
    directive: "",
    design: null,
  };
}

export function reduceWizard(state: WizardInput, action: WizardAction): WizardInput {
  switch (action.type) {
    case "next":
      return { ...state, step: Math.min(4, state.step + 1) as OnboardingStep };
    case "back":
      return { ...state, step: Math.max(1, state.step - 1) as OnboardingStep };
    case "initGit":
      return { ...state, initGit: action.value };
    case "lane":
      return { ...state, lanes: { ...state.lanes, [action.lane]: action.value } };
    case "directive":
      return { ...state, directive: action.value };
    case "design":
      return { ...state, design: action.design };
  }
}

/** The reason a folder cannot be onboarded at all — a Lead or Supervisor already runs there. */
export function blockerOf(inspection: Inspection): "lead-live" | "supervisor-live" | null {
  if (inspection.existingLead) return "lead-live";
  if (inspection.existingSupervisor) return "supervisor-live";
  return null;
}

/**
 * May `step` hand over to the next? Only the Folder step gates: it needs an
 * inspection, nothing already running there, and a Git repository (or the
 * Owner's yes to initialise one). Missing prerequisites warn on step 2 and
 * stay on the panel's Needs-you list afterwards, so they never block.
 */
export function canAdvance(step: OnboardingStep, inspection: Inspection | null, initGit: boolean): boolean {
  if (step !== 1) return true;
  if (inspection === null) return false;
  if (blockerOf(inspection) !== null) return false;
  return inspection.gitRepo || initGit;
}

/** The commit RPC's payload — `initGit` only when the folder is not a repository, the directive trimmed or absent. */
export function commitInputOf(state: WizardInput, inspection: Inspection, folder: string): CommitInput {
  const directive = state.directive.trim();
  return {
    folder,
    ...(!inspection.gitRepo && state.initGit ? { initGit: true } : {}),
    models: { supervisor: state.lanes.supervisor, lead: state.lanes.lead, worker: state.lanes.worker },
    ...(state.design === null ? {} : { openDesignProjectId: state.design.projectId }),
    ...(directive === "" ? {} : { directive }),
  };
}

/** `Step 2 of 4 — Prerequisites`. */
export function stepLabel(step: OnboardingStep): string {
  return `Step ${step} of 4 — ${ONBOARDING_STEPS[step - 1]}`;
}

/** A thrown RPC error (the daemon unreachable) in the wizard's what-and-how-to-fix words. */
export function describeThrown(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not reach the Factory server (${reason}) — check that Paseo is running, then try again`;
}
