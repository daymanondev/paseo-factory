/**
 * The onboarding wizard (v0.6.0 W7, ADR 0056; the ADR 0017 amendment) — what a
 * workspace that is not yet a Project shows on Paseo Desktop, replacing the
 * folder picker and the pasted path. Four steps, "Step N of 4":
 *   1 Folder         — the workspace's own folder: Git repository or an offer to
 *                      initialise one, a no-commits warning, a hard stop when a
 *                      Lead or Supervisor already runs there.
 *   2 Prerequisites  — the required skills and tools, one Install all.
 *   3 Models         — Supervisor, Lead and Worker, prefilled from the machine
 *                      defaults, changed through the lane picker the Settings
 *                      and the Project menu use.
 *   4 Start          — optional Open Design link and live phase checklist;
 *                      Start Supervisor sets up the Project and opens the
 *                      Supervisor conversation directly (never a Lead).
 * Back keeps everything entered (onboarding-state.ts). A failed step says what
 * went wrong and how to fix it — the server's refusals already carry the fix —
 * and never leaves a spinner behind. The Shell owns every RPC and what happens
 * after Start (open the conversation, or finish on the Project panel); this
 * component never mounts on mobile. Test hooks: `factory-onboarding`,
 * `-progress`, `-next`, `-back`, `-start`, `-retry`, `-recheck`, `-init-git`,
 * `-install-all`, `-od`, `-error`, `-blocked`, `-profiles`,
 * `-profile-<id>`, `-profile-machine-defaults`, `-profile-modified`,
 * `-lane-<seat>`, `-lane-change-<seat>`, `-run-checklist`, `-phase-<id>`,
 * `-phase-status-<id>`, `-slow-note`, `-poll-warning`, `-run-retry`.
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { OnboardingPhase, OnboardingPhaseStatus, OnboardingRun, OnboardingRunResult } from "../../shared/rpc.ts";
import type { FactoryView } from "../../shared/view.ts";
import { Btn, RoleName, ToneBadge } from "../kit/pill.tsx";
import { CONTROL_SM, RADIUS, SPACING, factoryPalette, hoveredOf, text, thinkingColour, tint } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { LaneModalBody, PROJECT_OVERRIDE_CARDS, splitLaneParts } from "./lane-editor.tsx";
import type { LaneCard } from "./lane-editor.tsx";
import { ONBOARDING_LANES, ONBOARDING_STEPS, blockerOf, canAdvance, commitInputOf, describeThrown, initialWizard, reduceWizard, stepLabel } from "./onboarding-state.ts";
import type { CommitInput, DesignChoice, Inspection, OnboardingLaneName, WizardInput } from "./onboarding-state.ts";

type Failed = { ok: false; error: string };

const OPEN_WORKSPACE_LABEL = "Opening workspace / Supervisor";
const TRANSIENT_POLL_WARNING_THRESHOLD = 3;

export interface OpenWorkspaceState {
  status: OnboardingPhaseStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const INITIAL_OPEN_WORKSPACE: OpenWorkspaceState = {
  status: "pending",
  startedAt: null,
  finishedAt: null,
  error: null,
};

/** An Open Design project the host catalog offers. */
export interface DesignOption {
  projectId: string;
  projectName: string;
  screenCount: number;
}

/** The wizard's action surface — the Shell owns the RPC calls and what follows Start. */
export interface OnboardingActions {
  /** The read-only folder inspection (`factory.onboarding.inspect`). */
  inspect(folder: string): Promise<({ ok: true } & Omit<Inspection, "ok">) | Failed>;
  /** Install every required skill and tool (the same act as Settings → Skills & Tools). */
  installPrerequisites(): Promise<{ ok: true } | Failed>;
  /** The Open Design projects on this host. */
  listDesigns(): Promise<{ ok: true; projects: DesignOption[] } | Failed>;
  /** Start onboarding (`factory.onboarding.start` async run or legacy `factory.onboarding.commit`). */
  start(input: CommitInput): Promise<{ ok: true; run?: OnboardingRun } | Failed>;
  /** Query an active or recent onboarding run (`factory.onboarding.status`). */
  status?(input: { runId?: string; folder?: string }): Promise<{ ok: true; run: OnboardingRun | null } | Failed>;
  /** Execute the client-side `open-workspace` finalization (workspace + Factory panel + openAgent). */
  finalize?(result: OnboardingRunResult, input: CommitInput): Promise<{ ok: true } | Failed>;
}

const SEAT_ROLE: Record<OnboardingLaneName, "supervisor" | "lead" | "peer"> = {
  supervisor: "supervisor",
  lead: "lead",
  worker: "peer",
};

function onboardingSeatMeta(card: LaneCard): { lane: OnboardingLaneName; role: "supervisor" | "lead" | "peer"; label: string } {
  const lane = card.id as OnboardingLaneName;
  return {
    lane,
    role: SEAT_ROLE[lane],
    label: lane === "worker" ? "Worker" : card.title,
  };
}

/** UI-only state a host may seed — hosts and tests; never data the server owns. */
export interface OnboardingInitialUi {
  step?: 1 | 2 | 3 | 4;
  inspection?: Inspection;
  inspectError?: string;
  initGit?: boolean;
  lanes?: Record<OnboardingLaneName, string>;
  profileId?: string | null;
  profileModified?: boolean;
  design?: DesignChoice;
  installError?: string;
  startError?: string;
  designs?: DesignOption[];
  run?: OnboardingRun | null;
  openWorkspace?: Partial<OpenWorkspaceState> & { status: OnboardingPhaseStatus };
  pollWarning?: string | null;
  now?: number;
  pollIntervalMs?: number;
}

function phaseElapsedSeconds(startedAt: string | null, nowMs: number): number {
  if (startedAt === null) return 0;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000));
}

function buildChecklistPhases(run: OnboardingRun, openWorkspace: OpenWorkspaceState): OnboardingPhase[] {
  const hasOpenWorkspace = run.phases.some((phase) => phase.id === "open-workspace");
  if (hasOpenWorkspace) return run.phases;
  return [
    ...run.phases,
    {
      id: "open-workspace",
      label: OPEN_WORKSPACE_LABEL,
      status: openWorkspace.status,
      startedAt: openWorkspace.startedAt,
      finishedAt: openWorkspace.finishedAt,
      error: openWorkspace.error,
    },
  ];
}

function phaseStatusColour(palette: ReturnType<typeof factoryPalette>, status: OnboardingPhaseStatus): string {
  switch (status) {
    case "done":
      return palette.ok;
    case "running":
      return palette.lead;
    case "failed":
      return palette.bad;
    case "pending":
      return palette.idle;
  }
}

function ProfilePill({
  theme,
  label,
  active,
  colour,
  disabled,
  testID,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  active: boolean;
  colour: string;
  disabled: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const isHovered = hoveredOf(state);
        return {
          minHeight: CONTROL_SM,
          paddingHorizontal: SPACING[2.5],
          paddingVertical: 3,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: active ? colour : isHovered ? theme.colors.foregroundMuted : theme.colors.border,
          backgroundColor: active
            ? tint(colour, "18")
            : state.pressed || isHovered
              ? theme.colors.surface2
              : theme.colors.surface1,
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
        };
      }}
    >
      <Text
        style={{
          ...text(theme, "label"),
          fontWeight: active ? "600" : "500",
          color: active ? colour : theme.colors.foreground,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Note({ theme, tone, testID, children }: { theme: PluginTheme; tone?: Colour; testID?: string; children: ReactNode }) {
  return (
    <Text testID={testID} style={text(theme, "meta", tone)}>
      {children}
    </Text>
  );
}

/** A failed step: what went wrong, and how to fix it. */
function ErrorLine({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <View testID="factory-onboarding-error" accessibilityRole="alert" style={{ gap: SPACING[1] }}>
      <Text style={{ ...text(theme, "label"), color: factoryPalette(theme).bad }}>{children}</Text>
    </View>
  );
}

export function OnboardingWizard({
  theme,
  view,
  folder,
  actions,
  initialUi,
}: {
  theme: PluginTheme;
  /** The snapshot — the lane picker reads its provider catalog; step 3 prefills from `machineLanes` or `profiles`. */
  view: Pick<FactoryView, "lanes" | "machineLanes" | "providers"> & { profiles?: FactoryView["profiles"] };
  /** The workspace panel's folder; null when the panel is not bound to one. */
  folder: string | null;
  actions: OnboardingActions;
  initialUi?: OnboardingInitialUi;
}) {
  const profiles = view.profiles ?? [];
  const [input, dispatch] = useReducer(
    reduceWizard,
    undefined,
    (): WizardInput => {
      const base = initialWizard(view.machineLanes);
      const profileId = initialUi?.profileId ?? base.profileId;
      const matched = profileId === null ? null : (profiles.find((p) => p.id === profileId) ?? null);
      const profileLanes =
        matched !== null
          ? { supervisor: matched.lanes.supervisor, lead: matched.lanes.lead, worker: matched.lanes.worker }
          : null;
      const lanes = initialUi?.lanes ?? profileLanes ?? base.lanes;
      const profileModified =
        initialUi?.profileModified ??
        (profileLanes !== null && initialUi?.lanes !== undefined
          ? ONBOARDING_LANES.some((lane) => lanes[lane] !== profileLanes[lane])
          : false);
      return {
        step: initialUi?.step ?? base.step,
        initGit: initialUi?.initGit ?? base.initGit,
        lanes,
        profileId,
        profileLanes,
        profileModified,
        design: initialUi?.design ?? base.design,
      };
    },
  );
  const [inspection, setInspection] = useState<Inspection | null>(initialUi?.inspection ?? null);
  const [inspectError, setInspectError] = useState<string | null>(initialUi?.inspectError ?? null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(initialUi?.installError ?? null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(initialUi?.startError ?? null);
  const [run, setRun] = useState<OnboardingRun | null>(initialUi?.run ?? null);
  const [openWorkspace, setOpenWorkspace] = useState<OpenWorkspaceState>(() =>
    initialUi?.openWorkspace
      ? {
          status: initialUi.openWorkspace.status,
          startedAt: initialUi.openWorkspace.startedAt ?? null,
          finishedAt: initialUi.openWorkspace.finishedAt ?? null,
          error: initialUi.openWorkspace.error ?? null,
        }
      : INITIAL_OPEN_WORKSPACE,
  );
  const [pollWarning, setPollWarning] = useState<string | null>(initialUi?.pollWarning ?? null);
  const [nowMs, setNowMs] = useState<number>(() => initialUi?.now ?? Date.now());
  const [designs, setDesigns] = useState<DesignOption[] | null>(initialUi?.designs ?? null);
  const [designError, setDesignError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LaneCard | null>(null);
  const alive = useRef(true);
  const lastCommitInputRef = useRef<CommitInput | null>(null);
  const pollFailuresRef = useRef(0);
  const finalizingRunIdRef = useRef<string | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Looks at the folder — on mount, on Retry / Re-check, and after an install. */
  const check = async (): Promise<Inspection | null> => {
    if (folder === null) return null;
    setChecking(true);
    setInspectError(null);
    try {
      const reply = await actions.inspect(folder);
      if (!alive.current) return null;
      if (reply.ok) {
        setInspection(reply);
        return reply;
      }
      setInspectError(reply.error);
    } catch (error) {
      if (alive.current) setInspectError(describeThrown(error));
    } finally {
      if (alive.current) setChecking(false);
    }
    return null;
  };
  useEffect(() => {
    if (initialUi?.inspection !== undefined || initialUi?.inspectError !== undefined) return;
    void check();
  }, [folder]);

  const installAll = async (): Promise<void> => {
    setInstalling(true);
    setInstallError(null);
    try {
      const reply = await actions.installPrerequisites();
      if (!alive.current) return;
      if (!reply.ok) {
        setInstallError(reply.error);
        return;
      }
      const after = await check();
      if (after !== null && after.missingPrerequisites.length > 0) {
        setInstallError(`still missing after the install: ${after.missingPrerequisites.join(", ")}`);
      }
    } catch (error) {
      if (alive.current) setInstallError(describeThrown(error));
    } finally {
      if (alive.current) setInstalling(false);
    }
  };

  const loadDesigns = async (): Promise<void> => {
    setDesignError(null);
    try {
      const reply = await actions.listDesigns();
      if (!alive.current) return;
      if (reply.ok) setDesigns(reply.projects);
      else setDesignError(`${reply.error} — start without a design and link one later from the Project menu`);
    } catch (error) {
      if (alive.current) setDesignError(describeThrown(error));
    }
  };

  const effectiveCommitInput = (): CommitInput => {
    if (lastCommitInputRef.current !== null) return lastCommitInputRef.current;
    if (folder !== null && inspection !== null) return commitInputOf(input, inspection, folder);
    return { folder: folder ?? "" };
  };

  const runFinalize = async (runId: string, result: OnboardingRunResult, payload: CommitInput): Promise<void> => {
    if (finalizingRunIdRef.current === runId) return;
    finalizingRunIdRef.current = runId;
    const finalize = actionsRef.current.finalize;
    const startedAt = new Date().toISOString();
    if (finalize === undefined) {
      if (!alive.current) return;
      setOpenWorkspace({ status: "done", startedAt, finishedAt: startedAt, error: null });
      setStarting(false);
      return;
    }
    setOpenWorkspace({ status: "running", startedAt, finishedAt: null, error: null });
    setStartError(null);
    setStarting(true);
    try {
      const reply = await finalize(result, payload);
      if (!alive.current) return;
      const finishedAt = new Date().toISOString();
      if (reply.ok) {
        setOpenWorkspace({ status: "done", startedAt, finishedAt, error: null });
        setStarting(false);
      } else {
        finalizingRunIdRef.current = null;
        setOpenWorkspace({ status: "failed", startedAt, finishedAt, error: reply.error });
        setStartError(reply.error);
        setStarting(false);
      }
    } catch (error) {
      if (!alive.current) return;
      finalizingRunIdRef.current = null;
      const msg = describeThrown(error);
      setOpenWorkspace({ status: "failed", startedAt, finishedAt: new Date().toISOString(), error: msg });
      setStartError(msg);
      setStarting(false);
    }
  };

  const runActive = (run !== null && run.status === "running") || openWorkspace.status === "running";
  useEffect(() => {
    if (initialUi?.now !== undefined || !runActive) return;
    setNowMs(Date.now());
    const id = setInterval(() => {
      if (alive.current) setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [runActive, initialUi?.now]);

  useEffect(() => {
    if (run === null || run.status !== "running") return;
    const statusFn = actionsRef.current.status;
    if (statusFn === undefined) return;
    let cancelled = false;
    let inFlight = false;
    const intervalMs = initialUi?.pollIntervalMs ?? 750;
    const poll = async (): Promise<void> => {
      if (cancelled || !alive.current || inFlight) return;
      inFlight = true;
      try {
        const reply = await statusFn({ runId: run.runId });
        if (cancelled || !alive.current) return;
        if (!reply.ok) {
          pollFailuresRef.current += 1;
          if (pollFailuresRef.current >= TRANSIENT_POLL_WARNING_THRESHOLD) {
            setPollWarning("Temporary connection hiccup checking onboarding status — still retrying…");
          }
          return;
        }
        pollFailuresRef.current = 0;
        setPollWarning(null);
        if (reply.run === null) return;
        setRun(reply.run);
        if (reply.run.status === "failed") {
          setStartError(reply.run.error ?? "Onboarding failed");
          setStarting(false);
        } else if (reply.run.status === "succeeded" && reply.run.result !== null) {
          await runFinalize(reply.run.runId, reply.run.result, effectiveCommitInput());
        }
      } catch {
        if (cancelled || !alive.current) return;
        pollFailuresRef.current += 1;
        if (pollFailuresRef.current >= TRANSIENT_POLL_WARNING_THRESHOLD) {
          setPollWarning("Temporary connection hiccup checking onboarding status — still retrying…");
        }
      } finally {
        inFlight = false;
      }
    };
    const id = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [run?.runId, run?.status, initialUi?.pollIntervalMs]);

  const start = async (): Promise<void> => {
    if (folder === null || inspection === null) return;
    const payload = commitInputOf(input, inspection, folder);
    lastCommitInputRef.current = payload;
    pollFailuresRef.current = 0;
    finalizingRunIdRef.current = null;
    setStarting(true);
    setStartError(null);
    setPollWarning(null);
    setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
    try {
      const reply = await actions.start(payload);
      if (!alive.current) return;
      if (!reply.ok) {
        setStartError(reply.error);
        setStarting(false);
        return;
      }
      if (reply.run !== undefined) {
        setRun(reply.run);
        if (reply.run.status === "failed") {
          setStartError(reply.run.error ?? "Onboarding failed");
          setStarting(false);
        } else if (reply.run.status === "succeeded" && reply.run.result !== null) {
          await runFinalize(reply.run.runId, reply.run.result, payload);
        }
      }
      // On legacy synchronous success (reply.run === undefined) the Shell navigates away or refreshes.
    } catch (error) {
      if (alive.current) {
        setStartError(describeThrown(error));
        setStarting(false);
      }
    }
  };

  const retryRun = async (): Promise<void> => {
    if (run !== null && run.status === "succeeded" && openWorkspace.status === "failed" && run.result !== null) {
      await runFinalize(run.runId, run.result, effectiveCommitInput());
      return;
    }
    await start();
  };

  if (folder === null) {
    return (
      <View testID="factory-onboarding" style={{ gap: SPACING[2] }}>
        <Note theme={theme}>This panel is not bound to a workspace folder — open the Factory from a workspace to set it up.</Note>
      </View>
    );
  }

  const step = input.step;
  const blocker = inspection === null ? null : blockerOf(inspection);
  const advance = canAdvance(step, inspection, input.initGit);
  const busy = checking || installing || starting || runActive;
  const palette = factoryPalette(theme);
  const selectedProfile = input.profileId === null ? null : (profiles.find((p) => p.id === input.profileId) ?? null);
  const checklistPhases = run !== null ? buildChecklistPhases(run, openWorkspace) : [];
  const runningPhase = checklistPhases.find((phase) => phase.status === "running") ?? null;
  const showSlowNote = runningPhase !== null && phaseElapsedSeconds(runningPhase.startedAt, nowMs) >= 10;
  const runFailed = run !== null && (run.status === "failed" || openWorkspace.status === "failed");
  const effectiveStartError =
    startError ??
    (openWorkspace.status === "failed" ? (openWorkspace.error ?? "Could not open workspace") : null) ??
    (run !== null && run.status === "failed"
      ? (run.error ?? checklistPhases.find((phase) => phase.status === "failed")?.error ?? "Onboarding failed")
      : null);

  return (
    <View testID="factory-onboarding" style={{ gap: SPACING[3] }}>
      <View style={{ gap: SPACING[1.5] }}>
        <Text testID="factory-onboarding-progress" style={text(theme, "section")}>
          {stepLabel(step)}
        </Text>
        <View testID="factory-onboarding-steps" style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1.5] }}>
          {ONBOARDING_STEPS.map((name, idx) => {
            const num = idx + 1;
            const state = num < step ? "done" : num === step ? "active" : "pending";
            const colour = state === "done" ? palette.ok : state === "active" ? palette.lead : palette.idle;
            return (
              <View key={name} testID={`factory-onboarding-step-pill-${num}`} style={{ flex: 1, minWidth: 0, gap: SPACING[0.5] }}>
                <View style={{ height: 3, borderRadius: 2, backgroundColor: state === "pending" ? theme.colors.surface2 : colour }} />
                <Text style={{ ...text(theme, "badge"), color: colour }} numberOfLines={1}>
                  {num}. {name}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {step === 1 ? (
        <View testID="factory-onboarding-step-folder" style={{ gap: SPACING[1.5] }}>
          <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={2}>{folder}</Text>
          {checking && inspection === null ? <Note theme={theme}>Looking at the folder…</Note> : null}
          {inspectError !== null ? (
            <>
              <ToneBadge theme={theme} label="Inspection failed" colour={palette.bad} testID="factory-onboarding-status-badge" />
              <ErrorLine theme={theme}>{inspectError}</ErrorLine>
              <View style={{ flexDirection: "row" }}>
                <Btn theme={theme} small testID="factory-onboarding-retry" label="Retry" disabled={checking} onPress={() => void check()} />
              </View>
            </>
          ) : null}
          {inspection !== null ? (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACING[1.5] }}>
                {inspection.gitRepo ? (
                  <>
                    <ToneBadge theme={theme} label="Git repository" colour={palette.ok} testID="factory-onboarding-git-badge" />
                    {!inspection.hasCommits ? <ToneBadge theme={theme} label="No commits yet" colour={palette.wait} testID="factory-onboarding-commits-badge" /> : null}
                  </>
                ) : (
                  <ToneBadge theme={theme} label={input.initGit ? "Git will be initialised" : "Not a Git repository"} colour={palette.wait} testID="factory-onboarding-git-badge" />
                )}
                {blocker !== null ? (
                  <ToneBadge theme={theme} label={blocker === "lead-live" ? "Lead already live" : "Supervisor already live"} colour={palette.bad} testID="factory-onboarding-blocker-badge" />
                ) : null}
              </View>
              {!inspection.gitRepo ? (
                <View style={{ gap: SPACING[1.5] }}>
                  <Text style={{ ...text(theme, "meta"), color: palette.wait }}>This folder is not a Git repository. The Factory needs one for its worktrees and the Gate.</Text>
                  <View style={{ flexDirection: "row" }}>
                    <Btn
                      theme={theme}
                      small
                      testID="factory-onboarding-init-git"
                      label={input.initGit ? "Git will be initialised — undo" : "Initialise Git here"}
                      tone={input.initGit ? "foregroundMuted" : "accent"}
                      disabled={busy}
                      onPress={() => dispatch({ type: "initGit", value: !input.initGit })}
                    />
                  </View>
                  {input.initGit ? <Note theme={theme}>Git will be initialised when you press Start.</Note> : null}
                </View>
              ) : null}
              {inspection.gitRepo && !inspection.hasCommits ? (
                <Text style={{ ...text(theme, "meta"), color: palette.wait }}>No commits yet — worktrees may not branch until there is one. Setup will make the first commit for you.</Text>
              ) : null}
              {blocker !== null ? (
                <View testID="factory-onboarding-blocked" style={{ gap: SPACING[1.5] }}>
                  <Text style={{ ...text(theme, "label"), color: palette.bad }}>
                    {blocker === "lead-live"
                      ? "A Lead is already running in this folder — onboarding stops so a second Project chain is never created over a live one. Ask that Project's Supervisor to retire the Lead (or open a different workspace), then Re-check."
                      : "A Supervisor is already live in this folder — open it from Paseo, or revoke it first, then Re-check."}
                  </Text>
                  <View style={{ flexDirection: "row" }}>
                    <Btn theme={theme} small testID="factory-onboarding-recheck" label="Re-check" disabled={checking} onPress={() => void check()} />
                  </View>
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      {step === 2 ? (
        <View testID="factory-onboarding-step-prerequisites" style={{ gap: SPACING[1.5] }}>
          {inspection === null ? <Note theme={theme}>Go back and let the folder check finish first.</Note> : null}
          {inspection !== null
            ? inspection.prerequisites.map((item) => (
                <View key={item.id} testID={`factory-onboarding-prereq-${item.id}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                  <ToneBadge theme={theme} label={item.ready ? "ready" : "missing"} colour={item.ready ? palette.ok : palette.wait} testID={`factory-onboarding-prereq-badge-${item.id}`} />
                  <Text style={{ ...text(theme, "label"), flexShrink: 1 }}>{item.title}</Text>
                  {!item.ready && item.detail ? <Text style={{ ...text(theme, "meta"), color: palette.wait, flexShrink: 1 }}>{item.detail}</Text> : null}
                </View>
              ))
            : null}
          {inspection !== null && inspection.missingPrerequisites.length === 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
              <ToneBadge theme={theme} label="All ready" colour={palette.ok} testID="factory-onboarding-prereqs-ok" />
              <Note theme={theme}>All required skills and tools are installed.</Note>
            </View>
          ) : null}
          {inspection !== null && inspection.missingPrerequisites.length > 0 ? (
            <View style={{ gap: SPACING[1.5] }}>
              <Note theme={theme}>You can continue without them, but agents will fail on what is missing — it stays on the panel's Needs you list.</Note>
              <View style={{ flexDirection: "row" }}>
                <Btn
                  theme={theme}
                  small
                  solid
                  testID="factory-onboarding-install-all"
                  label={installing ? "Installing…" : "Install all"}
                  disabled={busy}
                  onPress={() => void installAll()}
                />
              </View>
            </View>
          ) : null}
          {installError !== null ? (
            <ErrorLine theme={theme}>
              Install failed: {installError}. To fix it, retry Install all, or install them from Settings → Skills &amp; Tools.
            </ErrorLine>
          ) : null}
        </View>
      ) : null}

      {step === 3 ? (
        <View testID="factory-onboarding-step-models" style={{ gap: SPACING[1.5] }}>
          {profiles.length > 0 ? (
            <View
              testID="factory-onboarding-profiles"
              style={{
                gap: SPACING[1.5],
                padding: SPACING[2],
                borderRadius: RADIUS.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <Text style={text(theme, "label")}>Lane profile</Text>
                {selectedProfile !== null && input.profileModified ? (
                  <ToneBadge theme={theme} label="modified" colour={palette.wait} dot={false} testID="factory-onboarding-profile-modified" />
                ) : null}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACING[1.5] }}>
                <ProfilePill
                  theme={theme}
                  label="Machine defaults"
                  active={input.profileId === null}
                  colour={palette.lead}
                  disabled={busy}
                  testID="factory-onboarding-profile-machine-defaults"
                  onPress={() => dispatch({ type: "machineDefaults", machineLanes: view.machineLanes })}
                />
                {profiles.map((profile) => (
                  <ProfilePill
                    key={profile.id}
                    theme={theme}
                    label={profile.name}
                    active={input.profileId === profile.id}
                    colour={palette.lead}
                    disabled={busy}
                    testID={`factory-onboarding-profile-${profile.id}`}
                    onPress={() => dispatch({ type: "profile", profile })}
                  />
                ))}
              </View>
              {selectedProfile?.description ? <Note theme={theme}>{selectedProfile.description}</Note> : null}
            </View>
          ) : null}
          <Note theme={theme}>
            {profiles.length === 0
              ? "Prefilled from your machine defaults — usually you just press Next."
              : selectedProfile === null
                ? "Prefilled from your machine defaults — pick a Lane profile or adjust seats below."
                : `Prefilled from "${selectedProfile.name}" — individual seat edits stay local to this Project.`}
          </Note>
          {PROJECT_OVERRIDE_CARDS.map((card) => {
            const { lane, role, label } = onboardingSeatMeta(card);
            const baseline = selectedProfile !== null ? selectedProfile.lanes[lane] : view.machineLanes[lane];
            const changed = input.lanes[lane] !== baseline;
            const thinking = splitLaneParts(input.lanes[lane]).thinking || "off";
            return (
              <View key={card.id} testID={`factory-onboarding-lane-${card.id}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                <View style={{ minWidth: 108 }}>
                  <RoleName theme={theme} role={role} label={label} />
                </View>
                <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>{input.lanes[lane]}</Text>
                <ToneBadge theme={theme} label={thinking} colour={thinkingColour(theme, thinking)} dot={false} testID={`factory-onboarding-lane-thinking-${card.id}`} />
                {changed ? <ToneBadge theme={theme} label="changed" colour={palette.wait} dot={false} testID={`factory-onboarding-lane-changed-${card.id}`} /> : null}
                <Btn theme={theme} small testID={`factory-onboarding-lane-change-${card.id}`} label="Change" tone="foregroundMuted" disabled={busy} onPress={() => setEditing(card)} />
              </View>
            );
          })}
          {editing !== null ? (
            <Modal open title={`Configure ${editing.title}`} onOpenChange={(open: boolean) => (open ? undefined : setEditing(null))}>
              <Modal.Content>
                <LaneModalBody
                  theme={theme}
                  view={{ ...view, lanes: { ...view.lanes, ...input.lanes } } as FactoryView}
                  card={editing}
                  busy={false}
                  onSave={(value) => {
                    dispatch({ type: "lane", lane: editing.id as OnboardingLaneName, value });
                    setEditing(null);
                  }}
                  onClose={() => setEditing(null)}
                />
              </Modal.Content>
            </Modal>
          ) : null}
        </View>
      ) : null}

      {step === 4 ? (
        <View testID="factory-onboarding-step-start" style={{ gap: SPACING[2] }}>
          <View
            testID="factory-onboarding-summary"
            style={{
              gap: SPACING[1.5],
              padding: SPACING[2.5],
              borderRadius: RADIUS.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
              <Text style={{ ...text(theme, "badge"), textTransform: "uppercase" }}>Summary</Text>
              <ToneBadge
                theme={theme}
                label={inspection === null ? "Pending" : inspection.gitRepo ? "Git ready" : input.initGit ? "Initialise Git" : "Git required"}
                colour={inspection === null ? palette.idle : inspection.gitRepo ? palette.ok : palette.wait}
              />
            </View>
            <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={1}>{folder}</Text>
            <View style={{ gap: SPACING[1] }}>
              {PROJECT_OVERRIDE_CARDS.map((card) => {
                const { lane, role, label } = onboardingSeatMeta(card);
                return (
                  <View key={card.id} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                    <View style={{ minWidth: 96 }}>
                      <RoleName theme={theme} role={role} label={label} />
                    </View>
                    <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>{input.lanes[lane]}</Text>
                  </View>
                );
              })}
            </View>
            <Text style={text(theme, "meta")}>
              {selectedProfile !== null ? `Profile: ${selectedProfile.name}${input.profileModified ? " (modified)" : ""} · ` : ""}
              Open Design: {input.design === null ? "Not linked" : input.design.projectName}
              {inspection !== null ? ` · Prerequisites: ${inspection.missingPrerequisites.length === 0 ? "all ready" : `${inspection.missingPrerequisites.length} missing`}` : ""}
            </Text>
          </View>
          <View testID="factory-onboarding-od" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Open Design link (optional)</Text>
            {input.design !== null ? (
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                <Text style={text(theme, "meta")}>Linked: {input.design.projectName}</Text>
                <Btn theme={theme} small testID="factory-onboarding-od-clear" label="Clear" tone="foregroundMuted" disabled={busy} onPress={() => dispatch({ type: "design", design: null })} />
              </View>
            ) : designs === null ? (
              <View style={{ flexDirection: "row" }}>
                <Btn theme={theme} small testID="factory-onboarding-od-choose" label="Choose a design…" tone="foregroundMuted" disabled={busy} onPress={() => void loadDesigns()} />
              </View>
            ) : designs.length === 0 ? (
              <Note theme={theme}>No Open Design projects found on this host — you can link one later from the Project menu.</Note>
            ) : (
              designs.map((design) => (
                <View key={design.projectId} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                  <Btn
                    theme={theme}
                    small
                    testID={`factory-onboarding-od-pick-${design.projectId}`}
                    label={design.projectName}
                    tone="foregroundMuted"
                    disabled={busy}
                    onPress={() => dispatch({ type: "design", design: { projectId: design.projectId, projectName: design.projectName } })}
                  />
                  <Text style={text(theme, "meta")}>{design.screenCount} screens</Text>
                </View>
              ))
            )}
            {designError !== null ? <Note theme={theme} tone="statusDanger">{designError}</Note> : null}
          </View>
          <Note theme={theme}>
            Start Supervisor sets up the Project and opens the Supervisor conversation directly.
          </Note>
          {run !== null ? (
            <View
              testID="factory-onboarding-run-checklist"
              style={{
                gap: SPACING[1.5],
                padding: SPACING[2.5],
                borderRadius: RADIUS.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              }}
            >
              {checklistPhases.map((phase) => {
                const colour = phaseStatusColour(palette, phase.status);
                const elapsed = phase.status === "running" ? phaseElapsedSeconds(phase.startedAt, nowMs) : null;
                return (
                  <View key={phase.id} testID={`factory-onboarding-phase-${phase.id}`} style={{ gap: SPACING[0.5] }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: SPACING[2] }}>
                      <View style={{ flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0, gap: SPACING[2] }}>
                        <ToneBadge
                          theme={theme}
                          label={phase.status}
                          colour={colour}
                          testID={`factory-onboarding-phase-status-${phase.id}`}
                        />
                        <Text
                          style={{
                            ...text(theme, "label"),
                            color: phase.status === "pending" ? theme.colors.foregroundMuted : theme.colors.foreground,
                            flexShrink: 1,
                          }}
                        >
                          {phase.label}
                        </Text>
                      </View>
                      {elapsed !== null ? (
                        <Text
                          testID={`factory-onboarding-phase-elapsed-${phase.id}`}
                          style={{ ...text(theme, "code", "foregroundMuted"), fontVariant: ["tabular-nums"] }}
                        >
                          {elapsed}s
                        </Text>
                      ) : null}
                    </View>
                    {phase.status === "failed" && phase.error ? (
                      <Text style={{ ...text(theme, "meta"), color: palette.bad }}>{phase.error}</Text>
                    ) : null}
                  </View>
                );
              })}
              {showSlowNote ? (
                <Text testID="factory-onboarding-slow-note" style={text(theme, "meta")}>
                  Still waiting on Paseo and the model provider to finish starting the Supervisor — this can take up to a minute under load. You do not need to restart.
                </Text>
              ) : null}
              {pollWarning !== null ? (
                <Text testID="factory-onboarding-poll-warning" style={{ ...text(theme, "meta"), color: palette.wait }}>
                  {pollWarning}
                </Text>
              ) : null}
            </View>
          ) : null}
          {effectiveStartError !== null ? <ErrorLine theme={theme}>{effectiveStartError}</ErrorLine> : null}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        {step > 1 ? (
          <Btn
            theme={theme}
            small
            testID="factory-onboarding-back"
            label="Back"
            tone="foregroundMuted"
            disabled={busy}
            onPress={() => {
              if (step === 4 && !runActive) {
                setRun(null);
                setOpenWorkspace(INITIAL_OPEN_WORKSPACE);
                setStartError(null);
                setPollWarning(null);
              }
              dispatch({ type: "back" });
            }}
          />
        ) : null}
        {step < 4 ? (
          <Btn theme={theme} small solid testID="factory-onboarding-next" label="Next" disabled={busy || !advance} onPress={() => dispatch({ type: "next" })} />
        ) : runFailed ? (
          <Btn
            theme={theme}
            small
            solid
            testID="factory-onboarding-run-retry"
            icon="RotateCcw"
            label="Retry"
            disabled={busy}
            onPress={() => void retryRun()}
          />
        ) : (
          <Btn
            theme={theme}
            small
            solid
            testID="factory-onboarding-start"
            icon="Play"
            label={starting || runActive ? "Starting…" : "Start Supervisor"}
            disabled={busy || inspection === null}
            onPress={() => void start()}
          />
        )}
      </View>
    </View>
  );
}
