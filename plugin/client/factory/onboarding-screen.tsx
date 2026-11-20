/**
 * Global Onboarding screen (`paseo-factory-onboard`, ADR 0063) — desktop-only.
 * Offers 1-click selection of unregistered Paseo Projects from `paseo.projects.list()`
 * and a visual Folder Browser backed by read-only `onboardingBrowse`, then
 * mounts the shared 4-step `<OnboardingWizard />` inline without mutating disk
 * until Step 4 Start.
 *
 * Uses `usePaseo()` + `useRpc()` rather than `@getpaseo/plugin`'s `client-state`
 * hooks (`useProjects` / `useWorkspaces`), because `addScreen` surfaces run
 * under `PaseoApiProvider` + `PluginRpcProvider` without `PluginClientStateProvider`.
 *
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginClientOpenPanelOptions, PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import type { OnboardingRunResult } from "../../shared/rpc.ts";
import {
  onboardingBrowse,
  onboardingCommit,
  onboardingInspect,
  onboardingStart,
  onboardingStatus,
  openDesignCatalog,
  pluginsInstall,
  seatsDirectory,
  snapshot,
} from "../../shared/rpc.ts";
import type { FactoryView, ProjectDirectoryEntry } from "../../shared/view.ts";
import { Btn, Card, ToneBadge } from "../kit/pill.tsx";
import { RADIUS, SPACING, factoryPalette, hoveredOf, text } from "../kit/theme.ts";
import { OnboardingRunSubscriber, useOnboardingRunTracker } from "./onboarding-run-tracker.tsx";
import { describeThrown } from "./onboarding-state.ts";
import type { CommitInput } from "./onboarding-state.ts";
import {
  filterUnregisteredProjects,
  isFactoryRegisteredRoot,
  isReusableLocalWorkspace,
  normalizeFolderPath,
  projectDisplayLabel,
  resolveOrCreateProjectWorkspace,
} from "./onboarding-targets.ts";
import type { PaseoProjectTarget, WorkspaceCandidate } from "./onboarding-targets.ts";
import { OnboardingWizard } from "./onboarding-wizard.tsx";

export { filterUnregisteredProjects, isFactoryRegisteredRoot, isReusableLocalWorkspace, normalizeFolderPath };
export type { WorkspaceCandidate };

type BrowseView = Extract<z.output<typeof onboardingBrowse.output>, { ok: true }>;
export type OnboardingCommitSuccess = Extract<z.output<typeof onboardingCommit.output>, { ok: true }>;

const FACTORY_PANEL_ID = "paseo-factory";

function SelectableFolderRow({
  theme,
  testID,
  title,
  subtitle,
  gitRepo,
  badgeLabel,
  badgeTestID,
  showChevron = false,
  compact = false,
  onPress,
}: {
  theme: PluginScreenProps["theme"];
  testID: string;
  title: string;
  subtitle?: string;
  gitRepo: boolean;
  badgeLabel?: string;
  badgeTestID?: string;
  showChevron?: boolean;
  compact?: boolean;
  onPress: () => void;
}) {
  const palette = factoryPalette(theme);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: SPACING[2],
        paddingHorizontal: SPACING[2.5],
        paddingVertical: compact ? SPACING[1.5] : SPACING[2],
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: hoveredOf(state) ? theme.colors.accent : theme.colors.border,
        backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : theme.colors.surface0,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flex: 1, minWidth: 0 }}>
        <Icon name={gitRepo ? "GitBranch" : "Folder"} size={14} color={gitRepo ? palette.ok : theme.colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
            {title}
          </Text>
          {subtitle !== undefined ? (
            <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
        {badgeLabel !== undefined ? (
          <ToneBadge
            theme={theme}
            label={badgeLabel}
            colour={gitRepo ? palette.ok : palette.idle}
            dot={false}
            {...(badgeTestID === undefined ? {} : { testID: badgeTestID })}
          />
        ) : null}
        {showChevron ? <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} /> : null}
      </View>
    </Pressable>
  );
}

function UnregisteredProjectRow({
  project,
  theme,
  onSelect,
}: {
  project: PaseoProjectTarget;
  theme: PluginScreenProps["theme"];
  onSelect: (folder: string) => void;
}) {
  const isGit = project.projectKind === "git";
  return (
    <SelectableFolderRow
      theme={theme}
      testID={`factory-onboard-project-${project.projectId}`}
      title={projectDisplayLabel(project)}
      subtitle={project.projectRootPath}
      gitRepo={isGit}
      badgeLabel={isGit ? "Git" : "Folder"}
      badgeTestID={`factory-onboard-project-badge-${project.projectId}`}
      showChevron
      onPress={() => onSelect(project.projectRootPath)}
    />
  );
}

export function OnboardingScreen({
  theme,
  layout,
  host,
  navigation,
  params,
  openPanel,
  onCommitted,
}: PluginScreenProps & {
  openPanel?: (id: string, options: PluginClientOpenPanelOptions) => void;
  onCommitted?: (result: { input: CommitInput; reply: OnboardingCommitSuccess }) => Promise<void> | void;
}) {
  const mobile = layout.platform === "ios" || layout.platform === "android";
  const toast = useToast();
  const paseo = usePaseo();
  const seatsDirectoryCall = useRpc(seatsDirectory);
  const snapshotCall = useRpc(snapshot);
  const browseCall = useRpc(onboardingBrowse);
  const inspectCall = useRpc(onboardingInspect);
  const startCall = useRpc(onboardingStart);
  const statusCall = useRpc(onboardingStatus);
  const pluginsInstallCall = useRpc(pluginsInstall);
  const openDesignCatalogCall = useRpc(openDesignCatalog);

  const [registeredProjects, setRegisteredProjects] = useState<readonly ProjectDirectoryEntry[]>([]);
  const [paseoProjects, setPaseoProjects] = useState<readonly PaseoProjectTarget[]>([]);
  const [view, setView] = useState<FactoryView | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(() => {
    const initial = params?.folder?.trim();
    return initial ? initial : null;
  });

  const [browse, setBrowse] = useState<BrowseView | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [pathInput, setPathInput] = useState("");

  const alive = useRef(true);
  const browseSeq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const browseTo = useCallback(
    async (target?: string): Promise<void> => {
      if (mobile) return;
      const seq = ++browseSeq.current;
      setBrowsing(true);
      setBrowseError(null);
      try {
        const reply = await browseCall(target === undefined || target.trim() === "" ? {} : { path: target.trim() });
        if (!alive.current || seq !== browseSeq.current) return;
        if (reply.ok) {
          setBrowse(reply);
          setPathInput(reply.path);
        } else {
          setBrowseError(reply.error);
        }
      } catch (error) {
        if (alive.current && seq === browseSeq.current) {
          setBrowseError(describeThrown(error));
        }
      } finally {
        if (alive.current && seq === browseSeq.current) setBrowsing(false);
      }
    },
    [browseCall, mobile],
  );

  const refreshPaseoProjects = useCallback(async (): Promise<void> => {
    if (mobile || typeof paseo?.projects?.list !== "function") return;
    try {
      const listed = await paseo.projects.list();
      if (alive.current && Array.isArray(listed?.projects)) {
        setPaseoProjects(listed.projects);
      }
    } catch {
      // Host projects list is advisory; Folder Browser remains usable on failure.
    }
  }, [mobile, paseo]);

  const loadSnapshotAndDirectory = useCallback(async (): Promise<void> => {
    if (mobile) return;
    setSnapshotError(null);
    const [dirResult, snapResult] = await Promise.allSettled([
      seatsDirectoryCall({}),
      snapshotCall({}),
      refreshPaseoProjects(),
    ]);
    if (!alive.current) return;
    if (dirResult.status === "fulfilled" && dirResult.value.ok) {
      setRegisteredProjects(dirResult.value.projects);
    }
    if (snapResult.status === "fulfilled") {
      if (snapResult.value.ok) {
        setView(snapResult.value.view);
      } else {
        setSnapshotError(snapResult.value.error);
      }
    } else {
      setSnapshotError(describeThrown(snapResult.reason));
    }
  }, [mobile, refreshPaseoProjects, seatsDirectoryCall, snapshotCall]);

  useEffect(() => {
    if (mobile) return;
    void loadSnapshotAndDirectory();
    void browseTo();
    if (typeof paseo?.projects?.subscribe === "function") {
      return paseo.projects.subscribe(() => {
        void refreshPaseoProjects();
      });
    }
    return undefined;
  }, [mobile]);

  const unregisteredProjects = useMemo(
    () =>
      filterUnregisteredProjects(paseoProjects, registeredProjects).sort((a, b) =>
        projectDisplayLabel(a).localeCompare(projectDisplayLabel(b)),
      ),
    [paseoProjects, registeredProjects],
  );

  const toastedRunIdsRef = useRef<Set<string>>(new Set());
  const toastRunOnce = useCallback(
    (result: OnboardingRunResult, runId: string): void => {
      if (toastedRunIdsRef.current.has(runId)) return;
      toastedRunIdsRef.current.add(runId);
      toast.show(result.summary, { variant: "success" });
    },
    [toast],
  );
  const [liveSubscriptionRuns, setLiveSubscriptionRuns] = useState<Readonly<Record<string, boolean>>>({});
  const subscriptionLive = Object.values(liveSubscriptionRuns).some(Boolean);
  const handleSubscriberLiveChange = useCallback((runId: string, live: boolean) => {
    setLiveSubscriptionRuns((prev) => {
      if ((prev[runId] ?? false) === live) return prev;
      const next = { ...prev };
      if (live) next[runId] = true;
      else delete next[runId];
      return next;
    });
  }, []);

  const onboardingTracker = useOnboardingRunTracker({
    activeFolder: mobile ? null : selectedFolder,
    subscriptionLive,
    start: (input) => startCall(input),
    status: (input) => statusCall(input),
    onActiveComplete: async (result, input, runId, isActive) => {
      toastRunOnce(result, runId);
      await loadSnapshotAndDirectory();
      if (!isActive()) return { ok: true as const };
      const workspaceResult = await resolveOrCreateProjectWorkspace({
        paseo,
        projectRoot: result.projectRoot,
        paseoProjects,
      });
      if (!isActive()) return { ok: true as const };
      if (workspaceResult.workspaceId === null) {
        toast.show(
          `Supervisor started, but workspace could not be opened: ${workspaceResult.error ?? "unknown error"}`,
          { variant: "warning" },
        );
        return { ok: false as const, error: workspaceResult.error ?? "Could not open workspace" };
      }
      navigation?.openWorkspace({ workspaceId: workspaceResult.workspaceId, serverId: host.id });
      openPanel?.(FACTORY_PANEL_ID, { workspaceId: workspaceResult.workspaceId, location: "workspace" });
      navigation?.openAgent({ agentId: result.agentId, serverId: host.id });
      if (onCommitted !== undefined && input !== null) {
        await onCommitted({ input, reply: { ok: true, ...result } });
      }
      return { ok: true as const };
    },
    onBackgroundComplete: (result, _input, runId) => {
      toastRunOnce(result, runId);
      void loadSnapshotAndDirectory();
    },
  });

  if (mobile) {
    return (
      <View testID="factory-onboard-mobile" style={{ padding: SPACING[4] }}>
        <Text style={text(theme, "meta")}>Project onboarding is available on Paseo Desktop.</Text>
      </View>
    );
  }

  const palette = factoryPalette(theme);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {onboardingTracker.runningRuns.map((runningRun) => (
        <OnboardingRunSubscriber
          key={runningRun.runId}
          projectRoot={runningRun.folder}
          onProgress={onboardingTracker.notifyProgress}
          onLiveChange={(live) => handleSubscriberLiveChange(runningRun.runId, live)}
        />
      ))}
      <View testID="factory-onboard-screen" style={{ padding: SPACING[4], gap: SPACING[4], maxWidth: 820, width: "100%", alignSelf: "center" }}>
        <View style={{ gap: SPACING[1] }}>
          <Text style={text(theme, "detailTitle")}>Onboard Project to Factory</Text>
          <Text style={text(theme, "meta")}>
            Pick an unregistered Paseo Project or browse any folder on this host. Nothing writes to disk until you confirm Start Supervisor in Step 4.
          </Text>
        </View>

        {selectedFolder === null ? (
          <View style={{ gap: SPACING[4] }}>
            <Card theme={theme}>
              <View testID="factory-onboard-projects" style={{ gap: SPACING[2] }}>
                <Text style={text(theme, "section")}>Unregistered Paseo Projects</Text>
                {unregisteredProjects.length === 0 ? (
                  <Text style={text(theme, "meta")}>
                    No unregistered Paseo Projects on this host — pick any folder below.
                  </Text>
                ) : (
                  <View style={{ gap: SPACING[1.5] }}>
                    {unregisteredProjects.map((project) => (
                      <UnregisteredProjectRow
                        key={project.projectId}
                        project={project}
                        theme={theme}
                        onSelect={setSelectedFolder}
                      />
                    ))}
                  </View>
                )}
              </View>
            </Card>

            <Card theme={theme}>
              <View testID="factory-onboard-browse" style={{ gap: SPACING[2.5] }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
                  <Text style={text(theme, "section")}>Browse Host Folders</Text>
                  <Btn
                    theme={theme}
                    testID="factory-onboard-select-folder"
                    label="Select this folder"
                    variant="primary"
                    icon="Check"
                    disabled={browsing || browse === null}
                    onPress={() => {
                      if (browse !== null) setSelectedFolder(browse.path);
                    }}
                  />
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
                  <Btn
                    theme={theme}
                    testID="factory-onboard-parent"
                    label="Up"
                    icon="ArrowUp"
                    small
                    disabled={browsing || browse === null || browse.parent === null}
                    onPress={() => {
                      if (browse?.parent) void browseTo(browse.parent);
                    }}
                  />
                  <TextInput
                    testID="factory-onboard-path-input"
                    value={pathInput}
                    onChangeText={setPathInput}
                    onSubmitEditing={() => void browseTo(pathInput)}
                    placeholder="~/path/to/project"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      ...text(theme, "code"),
                      color: theme.colors.foreground,
                      backgroundColor: theme.colors.surface0,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      borderRadius: RADIUS.md,
                      paddingHorizontal: SPACING[2.5],
                      paddingVertical: SPACING[1.5],
                    }}
                  />
                  <Btn
                    theme={theme}
                    testID="factory-onboard-path-go"
                    label="Open"
                    small
                    disabled={browsing || pathInput.trim() === ""}
                    onPress={() => void browseTo(pathInput)}
                  />
                </View>

                {browse !== null ? (
                  <Text testID="factory-onboard-current-path" style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
                    {browse.path}
                  </Text>
                ) : null}

                {browseError !== null ? (
                  <Text testID="factory-onboard-browse-error" style={{ ...text(theme, "label"), color: palette.bad }}>
                    {browseError}
                  </Text>
                ) : null}

                {browse === null && browsing ? (
                  <Loading />
                ) : browse !== null && browse.entries.length === 0 ? (
                  <Text style={text(theme, "meta")}>No subdirectories in this folder.</Text>
                ) : browse !== null ? (
                  <View style={{ gap: SPACING[1] }}>
                    {browse.entries.map((entry) => (
                      <SelectableFolderRow
                        key={entry.path}
                        theme={theme}
                        testID={`factory-onboard-entry-${entry.name}`}
                        title={entry.name}
                        gitRepo={entry.gitRepo}
                        {...(entry.gitRepo ? { badgeLabel: "Git", badgeTestID: `factory-onboard-entry-badge-${entry.name}` } : {})}
                        compact
                        onPress={() => void browseTo(entry.path)}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            </Card>
          </View>
        ) : (
          <Card theme={theme}>
            <View style={{ gap: SPACING[3] }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACING[2], flexWrap: "wrap" }}>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={text(theme, "label")}>Selected folder</Text>
                  <Text testID="factory-onboard-selected-folder" style={text(theme, "code")} numberOfLines={1}>
                    {selectedFolder}
                  </Text>
                </View>
                <Btn
                  theme={theme}
                  testID="factory-onboard-change-folder"
                  label="Change folder"
                  small
                  onPress={() => setSelectedFolder(null)}
                />
              </View>

              {view === null ? (
                snapshotError !== null ? (
                  <View style={{ gap: SPACING[2] }}>
                    <Text style={{ ...text(theme, "label"), color: palette.bad }}>{snapshotError}</Text>
                    <Btn theme={theme} testID="factory-onboard-retry" label="Retry" small onPress={() => void loadSnapshotAndDirectory()} />
                  </View>
                ) : (
                  <Loading />
                )
              ) : (
                <OnboardingWizard
                  key={selectedFolder}
                  theme={theme}
                  view={view}
                  folder={selectedFolder}
                  tracker={onboardingTracker}
                  actions={{
                    inspect: (folder) => inspectCall({ folder }),
                    installPrerequisites: async () => {
                      const reply = await pluginsInstallCall({ target: "all", includeTools: true });
                      return reply.ok ? { ok: true } : { ok: false, error: reply.error };
                    },
                    listDesigns: async () => {
                      const reply = await openDesignCatalogCall({});
                      return reply.ok
                        ? {
                            ok: true as const,
                            projects: reply.projects.map((project) => ({
                              projectId: project.projectId,
                              projectName: project.projectName,
                              screenCount: project.screenCount,
                            })),
                          }
                        : { ok: false as const, error: reply.error };
                    },
                    start: (input) => startCall(input),
                    status: (input) => statusCall(input),
                  }}
                />
              )}
            </View>
          </Card>
        )}
      </View>
    </ScrollView>
  );
}
