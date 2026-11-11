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
 *   4 Start          — an optional first directive and an optional Open Design
 *                      link; Start creates the Supervisor (never a Lead).
 * Back keeps everything entered (onboarding-state.ts). A failed step says what
 * went wrong and how to fix it — the server's refusals already carry the fix —
 * and never leaves a spinner behind. The Shell owns every RPC and what happens
 * after Start (open the conversation, or finish on the Project panel); this
 * component never mounts on mobile. Test hooks: `factory-onboarding`,
 * `-progress`, `-next`, `-back`, `-start`, `-retry`, `-recheck`, `-init-git`,
 * `-install-all`, `-directive`, `-od`, `-error`, `-blocked`, `-lane-<seat>`,
 * `-lane-change-<seat>`. Function components only — no class syntax reaches the
 * Hermes bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { FactoryView } from "../../shared/view.ts";
import { Btn } from "../kit/pill.tsx";
import { CONTROL_H, RADIUS, SPACING, text } from "../kit/theme.ts";
import type { Colour } from "../kit/theme.ts";
import { LaneModalBody, PROJECT_OVERRIDE_CARDS } from "./seats.tsx";
import type { LaneCard } from "./seats.tsx";
import { blockerOf, canAdvance, commitInputOf, describeThrown, initialWizard, reduceWizard, stepLabel } from "./onboarding-state.ts";
import type { CommitInput, DesignChoice, Inspection, OnboardingLaneName, WizardInput } from "./onboarding-state.ts";

type Failed = { ok: false; error: string };

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
  /** The onboarding commit (`factory.onboarding.commit`); on success the Shell navigates. */
  start(input: CommitInput): Promise<{ ok: true } | Failed>;
}

/** UI-only state a host may seed — hosts and tests; never data the server owns. */
export interface OnboardingInitialUi {
  step?: 1 | 2 | 3 | 4;
  inspection?: Inspection;
  inspectError?: string;
  initGit?: boolean;
  lanes?: Record<OnboardingLaneName, string>;
  directive?: string;
  design?: DesignChoice;
  installError?: string;
  startError?: string;
  designs?: DesignOption[];
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
      <Text style={text(theme, "label", "statusDanger")}>{children}</Text>
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
  /** The snapshot — the lane picker reads its provider catalog; step 3 prefills from `machineLanes`. */
  view: Pick<FactoryView, "lanes" | "machineLanes" | "providers">;
  /** The workspace panel's folder; null when the panel is not bound to one. */
  folder: string | null;
  actions: OnboardingActions;
  initialUi?: OnboardingInitialUi;
}) {
  const [input, dispatch] = useReducer(
    reduceWizard,
    undefined,
    (): WizardInput => {
      const base = initialWizard(view.machineLanes);
      return {
        step: initialUi?.step ?? base.step,
        initGit: initialUi?.initGit ?? base.initGit,
        lanes: initialUi?.lanes ?? base.lanes,
        directive: initialUi?.directive ?? base.directive,
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
  const [designs, setDesigns] = useState<DesignOption[] | null>(initialUi?.designs ?? null);
  const [designError, setDesignError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LaneCard | null>(null);
  const alive = useRef(true);
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

  const start = async (): Promise<void> => {
    if (folder === null || inspection === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const reply = await actions.start(commitInputOf(input, inspection, folder));
      if (!alive.current) return;
      if (!reply.ok) {
        setStartError(reply.error);
        setStarting(false);
      }
      // On success the Shell navigates away (or the panel flips to the Project panel): nothing to reset.
    } catch (error) {
      if (alive.current) {
        setStartError(describeThrown(error));
        setStarting(false);
      }
    }
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
  const busy = checking || installing || starting;

  return (
    <View testID="factory-onboarding" style={{ gap: SPACING[3] }}>
      <Text testID="factory-onboarding-progress" style={text(theme, "section")}>
        {stepLabel(step)}
      </Text>

      {step === 1 ? (
        <View testID="factory-onboarding-step-folder" style={{ gap: SPACING[1.5] }}>
          <Text style={text(theme, "code", "foregroundMuted")} numberOfLines={2}>{folder}</Text>
          {checking && inspection === null ? <Note theme={theme}>Looking at the folder…</Note> : null}
          {inspectError !== null ? (
            <>
              <ErrorLine theme={theme}>{inspectError}</ErrorLine>
              <View style={{ flexDirection: "row" }}>
                <Btn theme={theme} small testID="factory-onboarding-retry" label="Retry" disabled={checking} onPress={() => void check()} />
              </View>
            </>
          ) : null}
          {inspection !== null ? (
            <>
              <Note theme={theme}>Git repository: {inspection.gitRepo ? "yes" : "no"}</Note>
              {!inspection.gitRepo ? (
                <View style={{ gap: SPACING[1.5] }}>
                  <Note theme={theme} tone="statusWarning">This folder is not a Git repository. The Factory needs one for its worktrees and the Gate.</Note>
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
                <Note theme={theme} tone="statusWarning">No commits yet — worktrees may not branch until there is one. Setup will make the first commit for you.</Note>
              ) : null}
              {blocker !== null ? (
                <View testID="factory-onboarding-blocked" style={{ gap: SPACING[1.5] }}>
                  <Text style={text(theme, "label", "statusDanger")}>
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
                  <Text style={{ ...text(theme, "label", item.ready ? undefined : "statusWarning"), flexShrink: 1 }}>{item.title}</Text>
                  <Text style={{ ...text(theme, "meta", item.ready ? undefined : "statusWarning"), flexShrink: 1 }}>{item.ready ? "ready" : (item.detail ?? "missing")}</Text>
                </View>
              ))
            : null}
          {inspection !== null && inspection.missingPrerequisites.length === 0 ? <Note theme={theme}>All required skills and tools are installed.</Note> : null}
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
          <Note theme={theme}>Prefilled from your machine defaults — usually you just press Next.</Note>
          {PROJECT_OVERRIDE_CARDS.map((card) => {
            const lane = card.id as OnboardingLaneName;
            const changed = input.lanes[lane] !== view.machineLanes[lane];
            return (
              <View key={card.id} testID={`factory-onboarding-lane-${card.id}`} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                <Text style={{ ...text(theme, "label"), minWidth: 76 }}>{card.title}</Text>
                <Text style={{ ...text(theme, "code"), flexShrink: 1 }} numberOfLines={1}>{input.lanes[lane]}</Text>
                {changed ? <Text style={text(theme, "meta")}>changed</Text> : null}
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
          <View style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>First directive (optional)</Text>
            <TextInput
              testID="factory-onboarding-directive"
              value={input.directive}
              onChangeText={(value: string) => dispatch({ type: "directive", value })}
              placeholder="What should the Supervisor start on?"
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              editable={!starting}
              style={{
                minHeight: CONTROL_H * 2,
                paddingHorizontal: SPACING[2.5],
                paddingVertical: SPACING[1.5],
                color: theme.colors.foreground,
                fontSize: 12,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: RADIUS.md,
                backgroundColor: theme.colors.surface1,
              }}
            />
          </View>
          <View testID="factory-onboarding-od" style={{ gap: SPACING[1] }}>
            <Text style={text(theme, "label")}>Open Design link (optional)</Text>
            {input.design !== null ? (
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
                <Text style={text(theme, "meta")}>Linked: {input.design.projectName}</Text>
                <Btn theme={theme} small testID="factory-onboarding-od-clear" label="Clear" tone="foregroundMuted" disabled={starting} onPress={() => dispatch({ type: "design", design: null })} />
              </View>
            ) : designs === null ? (
              <View style={{ flexDirection: "row" }}>
                <Btn theme={theme} small testID="factory-onboarding-od-choose" label="Choose a design…" tone="foregroundMuted" disabled={starting} onPress={() => void loadDesigns()} />
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
                    disabled={starting}
                    onPress={() => dispatch({ type: "design", design: { projectId: design.projectId, projectName: design.projectName } })}
                  />
                  <Text style={text(theme, "meta")}>{design.screenCount} screens</Text>
                </View>
              ))
            )}
            {designError !== null ? <Note theme={theme} tone="statusDanger">{designError}</Note> : null}
          </View>
          <Note theme={theme}>
            Start creates the Supervisor in this workspace.{" "}
            {input.directive.trim() === ""
              ? "With no directive you finish on the Project panel and talk to the Supervisor when you are ready."
              : "Your directive is sent as its first message and the conversation opens."}
          </Note>
          {startError !== null ? <ErrorLine theme={theme}>{startError}</ErrorLine> : null}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: SPACING[2] }}>
        {step > 1 ? <Btn theme={theme} small testID="factory-onboarding-back" label="Back" tone="foregroundMuted" disabled={busy} onPress={() => dispatch({ type: "back" })} /> : null}
        {step < 4 ? (
          <Btn theme={theme} small solid testID="factory-onboarding-next" label="Next" disabled={busy || !advance} onPress={() => dispatch({ type: "next" })} />
        ) : (
          <Btn
            theme={theme}
            small
            solid
            testID="factory-onboarding-start"
            icon="Play"
            label={starting ? "Starting…" : "Start Supervisor"}
            disabled={busy || inspection === null}
            onPress={() => void start()}
          />
        )}
      </View>
    </View>
  );
}
