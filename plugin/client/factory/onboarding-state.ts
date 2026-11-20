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

export interface ProfileChoice {
  id: string;
  lanes: Pick<Lanes, OnboardingLaneName>;
}

/** Everything the Owner has entered — kept across Back and Next. */
export interface WizardInput {
  step: OnboardingStep;
  /** The Owner accepted initialising Git for a folder that is not a repository. */
  initGit: boolean;
  lanes: Record<OnboardingLaneName, string>;
  /** Selected saved Lane profile id, or null when using machine defaults. */
  profileId: string | null;
  /** Snapshot of the selected profile's lanes so reverting a seat clears `profileModified`. */
  profileLanes: Record<OnboardingLaneName, string> | null;
  /** True when any seat currently differs from the selected Lane profile. */
  profileModified: boolean;
  design: DesignChoice | null;
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "step"; step: OnboardingStep }
  | { type: "initGit"; value: boolean }
  | { type: "lane"; lane: OnboardingLaneName; value: string }
  | { type: "profile"; profile: ProfileChoice }
  | { type: "machineDefaults"; machineLanes: Pick<Lanes, OnboardingLaneName> }
  | { type: "design"; design: DesignChoice | null };

function pickOnboardingLanes(lanes: Pick<Lanes, OnboardingLaneName>): Record<OnboardingLaneName, string> {
  return { supervisor: lanes.supervisor, lead: lanes.lead, worker: lanes.worker };
}

/** Step 3 is prefilled from the machine defaults. */
export function initialWizard(machineLanes: Pick<Lanes, OnboardingLaneName>): WizardInput {
  return {
    step: 1,
    initGit: false,
    lanes: pickOnboardingLanes(machineLanes),
    profileId: null,
    profileLanes: null,
    profileModified: false,
    design: null,
  };
}

export function reduceWizard(state: WizardInput, action: WizardAction): WizardInput {
  switch (action.type) {
    case "next":
      return { ...state, step: Math.min(4, state.step + 1) as OnboardingStep };
    case "back":
      return { ...state, step: Math.max(1, state.step - 1) as OnboardingStep };
    case "step":
      return { ...state, step: action.step };
    case "initGit":
      return { ...state, initGit: action.value };
    case "lane": {
      const lanes = { ...state.lanes, [action.lane]: action.value };
      const profileModified =
        state.profileId === null
          ? false
          : state.profileLanes !== null
            ? ONBOARDING_LANES.some((lane) => lanes[lane] !== state.profileLanes![lane])
            : state.profileModified || state.lanes[action.lane] !== action.value;
      return {
        ...state,
        lanes,
        profileModified,
      };
    }
    case "profile": {
      const profileLanes = pickOnboardingLanes(action.profile.lanes);
      return {
        ...state,
        profileId: action.profile.id,
        profileLanes,
        profileModified: false,
        lanes: profileLanes,
      };
    }
    case "machineDefaults":
      return {
        ...state,
        profileId: null,
        profileLanes: null,
        profileModified: false,
        lanes: pickOnboardingLanes(action.machineLanes),
      };
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

/** The start/commit RPC's payload — `initGit` only when the folder is not a repository, `profileId` when a profile is active. */
export function commitInputOf(state: WizardInput, inspection: Inspection, folder: string): CommitInput {
  return {
    folder,
    ...(!inspection.gitRepo && state.initGit ? { initGit: true } : {}),
    ...(state.profileId === null ? {} : { profileId: state.profileId }),
    models: { supervisor: state.lanes.supervisor, lead: state.lanes.lead, worker: state.lanes.worker },
    ...(state.design === null ? {} : { openDesignProjectId: state.design.projectId }),
  };
}

/** `Step 2 of 4 — Prerequisites`. */
export function stepLabel(step: OnboardingStep): string {
  return `Step ${step} of 4 — ${ONBOARDING_STEPS[step - 1]}`;
}

const TIMEOUT_ERROR_RE = /timed?\s*out|timeout|ETIMEDOUT/i;
const CONNECTION_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket|disconnect|unreachable|network|fetch failed|closed|not connected/i;

/** A thrown RPC error classified honestly: timeout, unreachable server, or underlying handler failure. */
export function describeThrown(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  const trimmed = reason.trim();
  if (TIMEOUT_ERROR_RE.test(trimmed)) {
    return `Paseo was busy and the request timed out (${trimmed}) — the action may still have finished; check status or retry.`;
  }
  if (CONNECTION_ERROR_RE.test(trimmed)) {
    return `Could not reach the Factory server (${trimmed}) — check that Paseo is running, then try again`;
  }
  return trimmed === "" ? "Request failed" : trimmed;
}
