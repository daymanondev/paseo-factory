/**
 * Quick Start onboarding (ADR 0073 amending ADR 0056 / ADR 0065) — what a
 * workspace that is not yet a Project shows on Paseo Desktop: a single screen
 * combining target folder + Git readiness (plus optional Git init and live
 * Supervisor/Lead blocker stops), a compact Lane profile selector with an
 * expandable `Customize models…` drawer (`Supervisor`, `Lead`, `Worker`), and
 * `Start Supervisor` with ADR 0065's live async phase checklist opening the
 * Supervisor conversation directly.
 * A failed step says what went wrong and how to fix it — and never leaves a
 * spinner behind. The Shell owns every RPC and what happens after Start; this
 * component never mounts on mobile. Test hooks: `factory-onboarding`,
 * `factory-quickstart`, `factory-quickstart-folder`,
 * `factory-quickstart-customize-models`, `factory-quickstart-models`,
 * `factory-quickstart-start`, `-retry`, `-recheck`, `-init-git`, `-error`,
 * `-blocked`, `-profiles`, `-profile-<id>`, `-profile-machine-defaults`,
 * `-profile-modified`, `-lane-<seat>`, `-lane-change-<seat>`,
 * `-run-checklist`, `-phase-<id>`, `-phase-status-<id>`, `-slow-note`,
 * `-poll-warning`, `-run-retry`.
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
import { INITIAL_OPEN_WORKSPACE, useOnboardingRunTracker } from "./onboarding-run-tracker.tsx";
import type { OnboardingRunTracker, OpenWorkspaceState } from "./onboarding-run-tracker.tsx";
import { ONBOARDING_LANES, blockerOf, canStartOnboarding, commitInputOf, describeThrown, initialWizard, reduceWizard } from "./onboarding-state.ts";
import type { CommitInput, Inspection, OnboardingLaneName, WizardInput } from "./onboarding-state.ts";

export type { OpenWorkspaceState };

type Failed = { ok: false; error: string };

const OPEN_WORKSPACE_LABEL = "Opening workspace / Supervisor";

/** Legacy Open Design option type retained for optional caller compatibility. */
export interface DesignOption {
  projectId: string;
  projectName: string;
  screenCount: number;
}

/** Quick Start's action surface — the Shell owns the RPC calls and what follows Start. */
export interface OnboardingActions {
  /** The read-only folder inspection (`factory.onboarding.inspect`). */
  inspect(folder: string): Promise<({ ok: true } & Omit<Inspection, "ok">) | Failed>;
  /** Optional legacy prerequisite installer (unused by single-screen Quick Start). */
  installPrerequisites?(): Promise<{ ok: true } | Failed>;
  /** Optional legacy Open Design catalog loader (unused by single-screen Quick Start). */
  listDesigns?(): Promise<{ ok: true; projects: DesignOption[] } | Failed>;
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
  inspection?: Inspection;
  inspectError?: string;
  initGit?: boolean;
  lanes?: Record<OnboardingLaneName, string>;
  profileId?: string | null;
  profileModified?: boolean;
  customizeModels?: boolean;
  startError?: string;
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
  tracker: externalTracker,
  initialUi,
}: {
  theme: PluginTheme;
  /** The snapshot — the lane picker reads its provider catalog; Quick Start prefills from `machineLanes` or `profiles`. */
  view: Pick<FactoryView, "lanes" | "machineLanes" | "providers"> & { profiles?: FactoryView["profiles"] };
  /** The workspace panel's folder; null when the panel is not bound to one. */
  folder: string | null;
  actions: OnboardingActions;
  /** Optional host-owned async onboarding run tracker (survives wizard unmount for background completion). */
  tracker?: OnboardingRunTracker;
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
        initGit: initialUi?.initGit ?? base.initGit,
        lanes,
        profileId,
        profileLanes,
        profileModified,
        customizeModels: initialUi?.customizeModels ?? base.customizeModels,
      };
    },
  );
  const [inspection, setInspection] = useState<Inspection | null>(initialUi?.inspection ?? null);
  const [inspectError, setInspectError] = useState<string | null>(initialUi?.inspectError ?? null);
  const [checking, setChecking] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => initialUi?.now ?? Date.now());
  const [editing, setEditing] = useState<LaneCard | null>(null);
  const alive = useRef(true);
  const lastCommitInputRef = useRef<CommitInput | null>(null);
  const inspectSeqRef = useRef(0);
  const prevFolderRef = useRef(folder);
  const submitInFlightRef = useRef(false);
  const submitSeqRef = useRef(0);

  const internalTracker = useOnboardingRunTracker({
    activeFolder: externalTracker === undefined ? folder : null,
    start: actions.start,
    ...(actions.status === undefined ? {} : { status: actions.status }),
    ...(actions.finalize === undefined ? {} : { onActiveComplete: (result, commitInput) => actions.finalize!(result, commitInput ?? effectiveCommitInput()) }),
    ...(initialUi?.pollIntervalMs === undefined ? {} : { pollIntervalMs: initialUi.pollIntervalMs }),
    ...(initialUi?.run === undefined ? {} : { initialRun: initialUi.run }),
    ...(initialUi?.openWorkspace === undefined
      ? {}
      : {
          initialOpenWorkspace: {
            status: initialUi.openWorkspace.status,
            startedAt: initialUi.openWorkspace.startedAt ?? null,
            finishedAt: initialUi.openWorkspace.finishedAt ?? null,
            error: initialUi.openWorkspace.error ?? null,
          },
        }),
    ...(initialUi?.pollWarning === undefined ? {} : { initialPollWarning: initialUi.pollWarning }),
    ...(initialUi?.startError === undefined ? {} : { initialStartError: initialUi.startError }),
  });
  const effectiveTracker = externalTracker ?? internalTracker;
  const run = effectiveTracker.activeRun;
  const openWorkspace = effectiveTracker.openWorkspace;
  const starting = effectiveTracker.starting;
  const startError = effectiveTracker.startError;
  const pollWarning = effectiveTracker.pollWarning;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Looks at the folder — on mount and on Retry / Re-check. */
  const check = async (): Promise<Inspection | null> => {
    if (folder === null) return null;
    const seq = ++inspectSeqRef.current;
    const targetFolder = folder;
    setChecking(true);
    setInspectError(null);
    setInspection(null);
    try {
      const reply = await actions.inspect(targetFolder);
      if (!alive.current || seq !== inspectSeqRef.current) return null;
      if (reply.ok) {
        setInspection(reply);
        if (initialUi?.run === undefined && effectiveTracker.activeRun === null) {
          void effectiveTracker.probeFolder(reply.folder, targetFolder);
        }
        return reply;
      }
      setInspectError(reply.error);
    } catch (error) {
      if (alive.current && seq === inspectSeqRef.current) {
        setInspectError(describeThrown(error));
      }
    } finally {
      if (alive.current && seq === inspectSeqRef.current) {
        setChecking(false);
      }
    }
    return null;
  };
  useEffect(() => {
    const folderChanged = prevFolderRef.current !== folder;
    prevFolderRef.current = folder;
    if (folderChanged) {
      inspectSeqRef.current += 1;
      submitSeqRef.current += 1;
      submitInFlightRef.current = false;
      setInspection(initialUi?.inspection ?? null);
      setInspectError(initialUi?.inspectError ?? null);
      setChecking(false);
      setEditing(null);
      lastCommitInputRef.current = null;
      if (initialUi?.initGit === undefined) {
        dispatch({ type: "initGit", value: false });
      }
    }
    if (initialUi?.inspection === undefined && initialUi?.inspectError === undefined) {
      void check();
    }
    return () => {
      inspectSeqRef.current += 1;
    };
  }, [folder]);

  const effectiveCommitInput = (): CommitInput => {
    if (lastCommitInputRef.current !== null) return lastCommitInputRef.current;
    if (folder !== null && inspection !== null) return commitInputOf(input, inspection, folder);
    return { folder: folder ?? "" };
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

  const start = async (): Promise<void> => {
    if (folder === null || inspection === null) return;
    if (submitInFlightRef.current || checking || starting || runActive || !canStartOnboarding(inspection, input.initGit)) return;
    const seq = ++submitSeqRef.current;
    submitInFlightRef.current = true;
    try {
      const payload = commitInputOf(input, inspection, folder);
      lastCommitInputRef.current = payload;
      await effectiveTracker.startRun(payload);
    } finally {
      if (seq === submitSeqRef.current) submitInFlightRef.current = false;
    }
  };

  const retryRun = async (): Promise<void> => {
    const canRetry = !checking && !starting && !runActive && !(run?.status === "failed" && !canStartOnboarding(inspection, input.initGit));
    if (submitInFlightRef.current || !canRetry) return;
    const seq = ++submitSeqRef.current;
    submitInFlightRef.current = true;
    try {
      const isClientOnlyRetry = run !== null && run.status === "succeeded" && openWorkspace.status === "failed";
      const payload =
        !isClientOnlyRetry && folder !== null && inspection !== null
          ? commitInputOf(input, inspection, folder)
          : effectiveCommitInput();
      if (!isClientOnlyRetry) {
        lastCommitInputRef.current = payload;
      }
      await effectiveTracker.retryRun(payload);
    } finally {
      if (seq === submitSeqRef.current) submitInFlightRef.current = false;
    }
  };

  if (folder === null) {
    return (
      <View testID="factory-onboarding" style={{ gap: SPACING[2] }}>
        <Note theme={theme}>This panel is not bound to a workspace folder — open the Factory from a workspace to set it up.</Note>
      </View>
    );
  }

  const blocker = inspection === null ? null : blockerOf(inspection);
  const canStart = canStartOnboarding(inspection, input.initGit);
  const busy = checking || starting || runActive;
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
      <View testID="factory-quickstart" style={{ gap: SPACING[3] }}>
        <View testID="factory-quickstart-folder" style={{ gap: SPACING[1.5] }}>
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
                      label={input.initGit ? "Git will be initialised — undo" : "Initialise Git repository"}
                      tone={input.initGit ? "foregroundMuted" : "accent"}
                      {...(input.initGit ? {} : { accentColour: palette.lead })}
                      disabled={busy}
                      onPress={() => dispatch({ type: "initGit", value: !input.initGit })}
                    />
                  </View>
                  {input.initGit ? <Note theme={theme}>Git will be initialised when you press Start Supervisor.</Note> : null}
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
              disabled={starting || runActive}
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
                disabled={starting || runActive}
                testID={`factory-onboarding-profile-${profile.id}`}
                onPress={() => dispatch({ type: "profile", profile })}
              />
            ))}
          </View>
          {selectedProfile?.description ? <Note theme={theme}>{selectedProfile.description}</Note> : null}
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
            <Btn
              theme={theme}
              small
              variant="ghost"
              icon={input.customizeModels ? "ChevronDown" : "ChevronRight"}
              testID="factory-quickstart-customize-models"
              label={input.customizeModels ? "Hide model customization" : "Customize models…"}
              disabled={starting || runActive}
              onPress={() => dispatch({ type: "customizeModels" })}
            />
          </View>
        </View>

        {input.customizeModels ? (
          <View testID="factory-quickstart-models" style={{ gap: SPACING[1.5] }}>
            <Note theme={theme}>
              {selectedProfile === null
                ? "Prefilled from your machine defaults — individual seat edits stay local to this Project."
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

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
          {runFailed ? (
            <Btn
              theme={theme}
              small
              solid
              accentColour={palette.lead}
              testID="factory-onboarding-run-retry"
              icon="RotateCcw"
              label="Retry"
              disabled={busy || (run?.status === "failed" && !canStart)}
              onPress={() => void retryRun()}
            />
          ) : (
            <Btn
              theme={theme}
              small
              solid
              accentColour={palette.lead}
              testID="factory-quickstart-start"
              icon="Play"
              label={starting || runActive ? "Starting…" : "Start Supervisor"}
              disabled={busy || !canStart}
              onPress={() => void start()}
            />
          )}
        </View>
      </View>
    </View>
  );
}
