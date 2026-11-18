/**
 * Global Onboarding screen (`paseo-factory-onboard`, ADR 0063) — desktop-only.
 * Offers 1-click selection of unregistered Paseo Projects from `useProjects()`
 * and a visual Folder Browser backed by read-only `onboardingBrowse`, then
 * mounts the shared 4-step `<OnboardingWizard />` inline without mutating disk
 * until Step 4 Start.
 *
 * Function components only — no class syntax reaches the Hermes bundle.
 */
import type { PluginProjectSnapshot } from "@getpaseo/plugin";
import type { PluginScreenProps, ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc } from "@getpaseo/plugin/client";
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
import { Btn, Card } from "../kit/pill.tsx";
import { RADIUS, SPACING, factoryPalette, hoveredOf, text, tint } from "../kit/theme.ts";
import type { CommitInput } from "./onboarding-state.ts";
import { OnboardingWizard } from "./onboarding-wizard.tsx";

type BrowseView = Extract<z.output<typeof onboardingBrowse.output>, { ok: true }>;
export type OnboardingCommitSuccess = Extract<z.output<typeof onboardingCommit.output>, { ok: true }>;

/** Trims trailing slashes (preserving `"/"`) so host project roots match Factory roots reliably. */
export function normalizeFolderPath(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed === "" || trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

/** True when `rootPath` matches any Project root already registered in Factory. */
export function isFactoryRegisteredRoot(
  rootPath: string,
  registeredProjects: readonly Pick<ProjectDirectoryEntry, "root">[],
): boolean {
  const normalized = normalizeFolderPath(rootPath);
  if (normalized === "") return false;
  return registeredProjects.some((project) => normalizeFolderPath(project.root) === normalized);
}

/** Pure filter helper for unregistered Paseo project snapshots. */
export function filterUnregisteredProjects<T extends Pick<PluginProjectSnapshot, "rootPath">>(
  projects: readonly T[],
  registeredProjects: readonly Pick<ProjectDirectoryEntry, "root">[],
): T[] {
  return projects.filter((project) => !isFactoryRegisteredRoot(project.rootPath, registeredProjects));
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
  const palette = factoryPalette(theme);
  const isGit = project.kind === "git";
  return (
    <Pressable
      testID={`factory-onboard-project-${project.ref.id}`}
      accessibilityRole="button"
      onPress={() => onSelect(project.rootPath)}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: SPACING[2],
        paddingHorizontal: SPACING[2.5],
        paddingVertical: SPACING[2],
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: hoveredOf(state) ? theme.colors.accent : theme.colors.border,
        backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : theme.colors.surface0,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flex: 1, minWidth: 0 }}>
        <Icon name={isGit ? "GitBranch" : "Folder"} size={14} color={isGit ? palette.ok : theme.colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
            {project.displayName}
          </Text>
          <Text style={{ ...text(theme, "code"), color: theme.colors.foregroundMuted }} numberOfLines={1}>
            {project.rootPath}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2] }}>
        <View
          style={{
            paddingHorizontal: SPACING[1.5],
            paddingVertical: 2,
            borderRadius: RADIUS.sm,
            borderWidth: 1,
            borderColor: tint(isGit ? palette.ok : palette.idle, "55"),
            backgroundColor: tint(isGit ? palette.ok : palette.idle, "18"),
          }}
        >
          <Text style={{ ...text(theme, "badge"), color: isGit ? palette.ok : palette.idle }}>
            {isGit ? "Git" : "Folder"}
          </Text>
        </View>
        <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

export function OnboardingScreen({
  theme,
  layout,
  host,
  navigation,
  params,
  onCommitted,
}: PluginScreenProps & {
  onCommitted?: (result: { input: CommitInput; reply: OnboardingCommitSuccess }) => Promise<void> | void;
}) {
  const mobile = layout.platform === "ios" || layout.platform === "android";
  const toast = useToast();
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
    if (onCommitted !== undefined) {
      await onCommitted({ input, reply });
    } else if ((input.directive ?? "") !== "") {
      navigation?.openAgent({ agentId: reply.agentId, serverId: host.id });
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
                      <Pressable
                        key={entry.path}
                        testID={`factory-onboard-entry-${entry.name}`}
                        accessibilityRole="button"
                        onPress={() => void browseTo(entry.path)}
                        style={(state) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: SPACING[2],
                          paddingHorizontal: SPACING[2.5],
                          paddingVertical: SPACING[1.5],
                          borderRadius: RADIUS.md,
                          borderWidth: 1,
                          borderColor: hoveredOf(state) ? theme.colors.accent : theme.colors.border,
                          backgroundColor: state.pressed || hoveredOf(state) ? theme.colors.surface2 : theme.colors.surface0,
                        })}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING[2], flex: 1, minWidth: 0 }}>
                          <Icon name={entry.gitRepo ? "GitBranch" : "Folder"} size={14} color={entry.gitRepo ? palette.ok : theme.colors.foregroundMuted} />
                          <Text style={text(theme, "rowTitle")} numberOfLines={1}>
                            {entry.name}
                          </Text>
                        </View>
                        {entry.gitRepo ? (
                          <View
                            style={{
                              paddingHorizontal: SPACING[1.5],
                              paddingVertical: 1,
                              borderRadius: RADIUS.sm,
                              borderWidth: 1,
                              borderColor: tint(palette.ok, "55"),
                              backgroundColor: tint(palette.ok, "18"),
                            }}
                          >
                            <Text style={{ ...text(theme, "badge"), color: palette.ok }}>Git</Text>
                          </View>
                        ) : null}
                      </Pressable>
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
                    <Btn theme={theme} label="Retry" small onPress={() => void loadSnapshotAndDirectory()} />
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
