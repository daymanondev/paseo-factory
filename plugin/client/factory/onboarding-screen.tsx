/**
 * Global Onboarding screen (`paseo-factory-onboard`, ADR 0063) — desktop-only.
 * Offers 1-click selection of unregistered Paseo Projects from `useProjects()`
 * and a visual Folder Browser backed by read-only `onboardingBrowse`, then
 * mounts the shared 4-step `<OnboardingWizard />` inline without mutating disk
 * until Step 4 Start.
 *
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginClientOpenPanelOptions, PluginScreenProps, ProjectRef } from "@getpaseo/plugin/client";
import { usePaseo, useProject, useProjects, useRpc, useWorkspaces } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import {
  onboardingBrowse,
  onboardingCommit,
  onboardingInspect,
  openDesignCatalog,
  pluginsInstall,
  seatsDirectory,
  snapshot,
} from "../../shared/rpc.ts";
import type { FactoryView, ProjectDirectoryEntry } from "../../shared/view.ts";
import { Btn, Card, ToneBadge } from "../kit/pill.tsx";
import { RADIUS, SPACING, factoryPalette, hoveredOf, text } from "../kit/theme.ts";
import type { CommitInput } from "./onboarding-state.ts";
import {
  filterUnregisteredProjects,
  isFactoryRegisteredRoot,
  isReusableLocalWorkspace,
  normalizeFolderPath,
  resolveOrCreateProjectWorkspace,
} from "./onboarding-targets.ts";
import type { WorkspaceCandidate } from "./onboarding-targets.ts";
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
  projectRef,
  theme,
  registeredProjects,
  onSelect,
}: {
  projectRef: ProjectRef;
  theme: PluginScreenProps["theme"];
  registeredProjects: readonly Pick<ProjectDirectoryEntry, "root">[];
  onSelect: (folder: string) => void;
}) {
  const project = useProject(projectRef);
  if (project === null || isFactoryRegisteredRoot(project.rootPath, registeredProjects)) return null;
  const isGit = project.kind === "git";
  return (
    <SelectableFolderRow
      theme={theme}
      testID={`factory-onboard-project-${project.ref.id}`}
      title={project.displayName}
      subtitle={project.rootPath}
      gitRepo={isGit}
      badgeLabel={isGit ? "Git" : "Folder"}
      badgeTestID={`factory-onboard-project-badge-${project.ref.id}`}
      showChevron
      onPress={() => onSelect(project.rootPath)}
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
  const commitCall = useRpc(onboardingCommit);
  const pluginsInstallCall = useRpc(pluginsInstall);
  const openDesignCatalogCall = useRpc(openDesignCatalog);

  const [registeredProjects, setRegisteredProjects] = useState<readonly ProjectDirectoryEntry[]>([]);
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
          setBrowseError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (alive.current && seq === browseSeq.current) setBrowsing(false);
      }
    },
    [browseCall, mobile],
  );

  const loadSnapshotAndDirectory = useCallback(async (): Promise<void> => {
    if (mobile) return;
    setSnapshotError(null);
    const [dirResult, snapResult] = await Promise.allSettled([seatsDirectoryCall({}), snapshotCall({})]);
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
      setSnapshotError(snapResult.reason instanceof Error ? snapResult.reason.message : String(snapResult.reason));
    }
  }, [mobile, seatsDirectoryCall, snapshotCall]);

  useEffect(() => {
    if (mobile) return;
    void loadSnapshotAndDirectory();
    void browseTo();
  }, [mobile]);

  const unregisteredRefs = useProjects({
    ...(host.id ? { hosts: [host.id] } : {}),
    where: (project) => !isFactoryRegisteredRoot(project.rootPath, registeredProjects),
    orderBy: "displayName",
  });
  const matchingProjectRefs = useProjects({
    ...(host.id ? { hosts: [host.id] } : {}),
    where: (project) =>
      selectedFolder !== null &&
      normalizeFolderPath(project.rootPath) === normalizeFolderPath(selectedFolder),
  });
  const activeWorkspaceRefs = useWorkspaces({
    ...(host.id ? { hosts: [host.id] } : {}),
    where: (workspace) =>
      selectedFolder !== null && isReusableLocalWorkspace(workspace, selectedFolder),
  });

  if (mobile) {
    return (
      <View testID="factory-onboard-mobile" style={{ padding: SPACING[4] }}>
        <Text style={text(theme, "meta")}>Project onboarding is available on Paseo Desktop.</Text>
      </View>
    );
  }

  const palette = factoryPalette(theme);

  const startOnboarding = async (input: CommitInput): Promise<{ ok: true } | { ok: false; error: string }> => {
    const reply = await commitCall(input);
    if (!reply.ok) return { ok: false, error: reply.error };
    toast.show(reply.summary, { variant: "success" });
    await loadSnapshotAndDirectory();
    const workspaceResult = await resolveOrCreateProjectWorkspace({
      paseo,
      projectRoot: reply.projectRoot,
      selectedFolder,
      activeWorkspaceRefs,
      matchingProjectRefs,
    });
    if (onCommitted !== undefined) {
      await onCommitted({ input, reply });
    }
    if ((input.directive ?? "").trim() !== "") {
      navigation?.openAgent({ agentId: reply.agentId, serverId: host.id });
    } else if (workspaceResult.workspaceId !== null) {
      navigation?.openWorkspace({ workspaceId: workspaceResult.workspaceId, serverId: host.id });
      openPanel?.(FACTORY_PANEL_ID, { workspaceId: workspaceResult.workspaceId, location: "workspace" });
    } else {
      toast.show(
        `Supervisor started, but workspace could not be opened: ${workspaceResult.error ?? "unknown error"}`,
        { variant: "warning" },
      );
      if (alive.current) setSelectedFolder(null);
    }
    return { ok: true };
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
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
                {unregisteredRefs.length === 0 ? (
                  <Text style={text(theme, "meta")}>
                    No unregistered Paseo Projects on this host — pick any folder below.
                  </Text>
                ) : (
                  <View style={{ gap: SPACING[1.5] }}>
                    {unregisteredRefs.map((ref) => (
                      <UnregisteredProjectRow
                        key={ref.key}
                        projectRef={ref}
                        theme={theme}
                        registeredProjects={registeredProjects}
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
                    start: startOnboarding,
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
