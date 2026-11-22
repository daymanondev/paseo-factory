/**
 * The surface's hosts (ADR 0009 §1; v0.6.0 W4/W8, ADR 0056; ADR 0063; ADR 0068):
 * the workspace panel (the Project panel, scoped to the active workspace's
 * directory via useWorkspace), the Settings screen (machine-wide, unscoped),
 * and the desktop-only global `Factory overview` sidebar header item + screen
 * alongside the global Onboarding screen route.
 */
import type {
  PluginClientOpenPanelOptions,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { sidebarOverviewBadgeStore } from "../kit/directory.ts";
import type { SidebarOverviewBadgePlan } from "../kit/directory.ts";
import { ToneBadge } from "../kit/pill.tsx";
import { SPACING, factoryPalette } from "../kit/theme.ts";
import type { SeatEditorRequests } from "./editor-request.ts";
import { OnboardingScreen } from "./onboarding-screen.tsx";
import { OVERVIEW_SCREEN_ID, OverviewScreen } from "./overview-screen.tsx";
import type { OverviewScreenProps } from "./overview-screen.tsx";
import { FactoryShell } from "./shell.tsx";
import { FactoryTabErrorBoundary } from "./tab-error-boundary.tsx";

export const PANEL_ID = "paseo-factory";
export const ONBOARD_SCREEN_ID = "paseo-factory-onboard";
export { OVERVIEW_SCREEN_ID };

function resolveSidebarRow(): typeof pluginUi.SidebarRow | null {
  const candidate = (pluginUi as { SidebarRow?: unknown }).SidebarRow;
  if (typeof candidate === "function") return candidate as typeof pluginUi.SidebarRow;
  if (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate) {
    return candidate as typeof pluginUi.SidebarRow;
  }
  return null;
}

const HostSidebarRow = resolveSidebarRow();

export type FactoryOverviewSidebarItemProps = PluginSidebarItemProps & {
  badge?: SidebarOverviewBadgePlan | null;
};

/** Desktop-only sidebar header item opening the single-tab `Factory overview` screen. */
export function FactoryOverviewSidebarItem({
  theme,
  layout,
  currentScreen,
  openScreen,
  badge,
}: FactoryOverviewSidebarItemProps) {
  const liveBadge = useSyncExternalStore(
    sidebarOverviewBadgeStore.subscribe,
    sidebarOverviewBadgeStore.getSnapshot,
    sidebarOverviewBadgeStore.getSnapshot,
  );
  if (layout.platform === "ios" || layout.platform === "android") return null;
  if (HostSidebarRow === null) return null;

  const summary = badge !== undefined ? badge : liveBadge;
  const palette = factoryPalette(theme);
  const trailing =
    summary === null ? undefined : (
      <View
        testID="factory-sidebar-overview-badge"
        style={{ flexDirection: "row", alignItems: "center", gap: SPACING[1] }}
      >
        {summary.needsYouCount > 0 ? (
          <ToneBadge
            theme={theme}
            label={`Needs you · ${summary.needsYouCount}`}
            colour={palette.wait}
            dot={false}
          />
        ) : null}
        {summary.runningCount > 0 ? (
          <ToneBadge
            theme={theme}
            label={summary.queuedCount > 0 ? `Gate · ${summary.runningCount}+${summary.queuedCount}` : "Gate running"}
            colour={palette.ok}
            dot
          />
        ) : summary.queuedCount > 0 ? (
          <ToneBadge
            theme={theme}
            label={summary.paused ? `Paused · ${summary.queuedCount}` : `${summary.queuedCount} queued`}
            colour={palette.wait}
            dot={false}
          />
        ) : null}
      </View>
    );

  return (
    <View testID="factory-sidebar-overview-entry">
      <HostSidebarRow
        icon="Activity"
        label="Factory"
        active={currentScreen?.screenId === OVERVIEW_SCREEN_ID}
        onPress={() => openScreen({ screenId: OVERVIEW_SCREEN_ID })}
        {...(trailing === undefined ? {} : { trailing })}
      />
    </View>
  );
}

export type FactoryOverviewScreenProps = OverviewScreenProps;

/** Desktop-only global `Factory overview` screen. */
export function FactoryOverviewScreen(props: FactoryOverviewScreenProps) {
  if (props.layout.platform === "ios" || props.layout.platform === "android") return null;
  return (
    <FactoryTabErrorBoundary theme={props.theme} section="Factory overview">
      <OverviewScreen {...props} />
    </FactoryTabErrorBoundary>
  );
}

export type FactoryOnboardScreenProps = PluginScreenProps & {
  openPanel?: (id: string, options: PluginClientOpenPanelOptions) => void;
};

/** Desktop-only global Onboarding screen for unregistered Paseo Projects and host folders. */
export function FactoryOnboardScreen(props: FactoryOnboardScreenProps) {
  if (props.layout.platform === "ios" || props.layout.platform === "android") return null;
  return (
    <FactoryTabErrorBoundary theme={props.theme} section="Onboarding">
      <OnboardingScreen {...props} />
    </FactoryTabErrorBoundary>
  );
}

/** The Settings screen: collapsible machine-wide sections — models & Lane profiles, skills & tools, plugins, Vault, diagnostics. */
export function FactorySettings({ theme, layout, navigation, host }: PluginSurfaceProps) {
  return <FactoryShell theme={theme} layout={layout} navigation={navigation} serverId={host.id} surface="settings" />;
}

/** The workspace panel: the Project panel scoped to this workspace's directory. */
export function FactoryPanel({ theme, layout, navigation, host, workspaceId, openSettings, openReleaseLab, editorRequests }: PluginWorkspacePanelProps & { openSettings?: () => void; openReleaseLab?: () => void; editorRequests?: SeatEditorRequests }) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const request = useSyncExternalStore(editorRequests?.subscribe ?? (() => () => {}), () => editorRequests?.get(workspaceId) ?? null);
  return <FactoryTabErrorBoundary theme={theme} section="Factory tab"><FactoryShell theme={theme} layout={layout} dir={dir ?? undefined} navigation={navigation} serverId={host.id} {...(request === null ? {} : { editorRequest: request, onEditorRequestHandled: () => editorRequests?.consume(workspaceId, request) })} {...(openSettings === undefined ? {} : { openSettings })} {...(openReleaseLab === undefined ? {} : { openReleaseLab })} /></FactoryTabErrorBoundary>;
}
