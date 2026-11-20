/**
 * The surface's hosts (ADR 0009 §1; v0.6.0 W4/W8, ADR 0056; ADR 0063):
 * the workspace panel (the Project panel, scoped to the active workspace's
 * directory via useWorkspace), the Settings screen (machine-wide, unscoped),
 * and the desktop-only global Onboarding screen + sidebar footer item.
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
import type { SeatEditorRequests } from "./editor-request.ts";
import { OnboardingScreen } from "./onboarding-screen.tsx";
import { FactoryShell } from "./shell.tsx";
import { FactoryTabErrorBoundary } from "./tab-error-boundary.tsx";

export const PANEL_ID = "paseo-factory";
export const ONBOARD_SCREEN_ID = "paseo-factory-onboard";

function resolveSidebarRow(): typeof pluginUi.SidebarRow | null {
  const candidate = (pluginUi as { SidebarRow?: unknown }).SidebarRow;
  if (typeof candidate === "function") return candidate as typeof pluginUi.SidebarRow;
  if (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate) {
    return candidate as typeof pluginUi.SidebarRow;
  }
  return null;
}

const HostSidebarRow = resolveSidebarRow();

/** Desktop-only sidebar footer item opening the global Onboarding screen. */
export function FactoryOnboardSidebarItem({ layout, currentScreen, openScreen }: PluginSidebarItemProps) {
  if (layout.platform === "ios" || layout.platform === "android") return null;
  if (HostSidebarRow === null) return null;
  return (
    <HostSidebarRow
      icon="FolderPlus"
      label="Onboard Project"
      active={currentScreen?.screenId === ONBOARD_SCREEN_ID}
      onPress={() => openScreen({ screenId: ONBOARD_SCREEN_ID })}
    />
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
