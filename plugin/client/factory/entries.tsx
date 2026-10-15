/**
 * The surface's three hosts (ADR 0009 §1): the global screen, the workspace
 * panel (scoped to the active workspace's directory via useWorkspace), and
 * the settings screen — all rendering the one FactoryShell. Plus the sidebar
 * header item that opens the screen.
 */
import type { PluginScreenProps, PluginSidebarItemProps, PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FactoryShell } from "./shell.tsx";

export const SCREEN_ID = "paseo-factory";

/** The global screen: every workspace's verification line. */
export function FactoryScreen({ theme, layout, navigation, host }: PluginSurfaceProps) {
  return <FactoryShell theme={theme} navigation={navigation} serverId={host.id} />;
}

/** The settings screen: lane config, supervisor controls, diagnostics — the same shell. */
export function FactorySettings({ theme, layout, navigation, host }: PluginSurfaceProps) {
  return <FactoryShell theme={theme} navigation={navigation} serverId={host.id} />;
}

/** The workspace panel: the shell scoped to this workspace's directory. */
export function FactoryPanel({ theme, layout, navigation, host, workspaceId }: PluginWorkspacePanelProps) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  return <FactoryShell theme={theme} dir={dir ?? undefined} navigation={navigation} serverId={host.id} />;
}

/** The sidebar header item: one row, opens the global screen. */
export function FactorySidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Activity" label="Factory" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}
