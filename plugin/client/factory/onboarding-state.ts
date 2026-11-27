/**
 * Quick Start onboarding's pure state machine (ADR 0073 amending ADR 0056):
 * tracks single-screen Quick Start inputs (Git init, seat lanes, Lane profile,
 * and collapsed-by-default model customization). It holds no RPC state and
 * draws nothing — the Quick Start component owns those — so state transitions
 * and readiness checks are plain functions a test can drive. Function-style
 * only; no class syntax reaches the Hermes bundle.
 */
import type { z } from "zod";
import type { onboardingCommit, onboardingInspect } from "../../shared/rpc.ts";
import type { Lanes } from "../../shared/view.ts";

/** What the folder-inspection RPC answers when it can answer. */
export type Inspection = Extract<z.output<typeof onboardingInspect.output>, { ok: true }>;
export type CommitInput = z.input<typeof onboardingCommit.input>;

/** The three seats the Project starts on — editable via Customize models…. */
export type OnboardingLaneName = "supervisor" | "lead" | "worker";
export const ONBOARDING_LANES: readonly OnboardingLaneName[] = ["supervisor", "lead", "worker"];

export interface ProfileChoice {
  id: string;
  lanes: Pick<Lanes, OnboardingLaneName>;
}

/** Everything the Owner has entered on Quick Start. */
export interface WizardInput {
  /** The Owner accepted initialising Git for a folder that is not a repository. */
  initGit: boolean;
  lanes: Record<OnboardingLaneName, string>;
  /** Selected saved Lane profile id, or null when using machine defaults. */
  profileId: string | null;
  /** Snapshot of the selected profile's lanes so reverting a seat clears `profileModified`. */
  profileLanes: Record<OnboardingLaneName, string> | null;
  /** True when any seat currently differs from the selected Lane profile. */
  profileModified: boolean;
  /** Whether the inline `Customize models…` drawer is expanded. */
  customizeModels: boolean;
}

export type WizardAction =
  | { type: "initGit"; value: boolean }
  | { type: "lane"; lane: OnboardingLaneName; value: string }
  | { type: "profile"; profile: ProfileChoice }
  | { type: "machineDefaults"; machineLanes: Pick<Lanes, OnboardingLaneName> }
  | { type: "customizeModels"; value?: boolean };

function pickOnboardingLanes(lanes: Pick<Lanes, OnboardingLaneName>): Record<OnboardingLaneName, string> {
  return { supervisor: lanes.supervisor, lead: lanes.lead, worker: lanes.worker };
}

/** Quick Start defaults to machine lanes with model customization collapsed. */
export function initialWizard(machineLanes: Pick<Lanes, OnboardingLaneName>): WizardInput {
  return {
    initGit: false,
    lanes: pickOnboardingLanes(machineLanes),
    profileId: null,
    profileLanes: null,
    profileModified: false,
    customizeModels: false,
  };
}

export function reduceWizard(state: WizardInput, action: WizardAction): WizardInput {
  switch (action.type) {
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
    case "customizeModels":
      return { ...state, customizeModels: action.value ?? !state.customizeModels };
  }
}

/** The reason a folder cannot be onboarded at all — a Lead or Supervisor already runs there. */
export function blockerOf(inspection: Inspection): "lead-live" | "supervisor-live" | null {
  if (inspection.existingLead) return "lead-live";
  if (inspection.existingSupervisor) return "supervisor-live";
  return null;
}

/**
 * May Quick Start start onboarding? Requires a completed folder inspection,
 * nothing already running there, and a Git repository (or the Owner's yes to
 * initialise one). Missing prerequisites stay handled on-demand by Supervisor /
 * Needs you and never block Quick Start.
 */
export function canStartOnboarding(inspection: Inspection | null, initGit: boolean): boolean {
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
  };
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
