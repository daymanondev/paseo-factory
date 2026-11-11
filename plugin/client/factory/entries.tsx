/**
 * The surface's two hosts (ADR 0009 §1; v0.6.0 W4, ADR 0056): the workspace
 * panel (scoped to the active workspace's directory via useWorkspace) and the
 * settings screen — both rendering the one FactoryShell. The global screen
 * and the sidebar header item are gone.
 */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { FactoryShell } from "./shell.tsx";

export const PANEL_ID = "paseo-factory";

/** The settings screen: lane config, supervisor controls, diagnostics — opens on Seats & Models. */
export function FactorySettings({ theme, layout, navigation, host }: PluginSurfaceProps) {
  return <FactoryShell theme={theme} layout={layout} navigation={navigation} serverId={host.id} initialTab="seats" showDiagnostics surface="settings" />;
}

/** The workspace panel: the shell scoped to this workspace's directory, with Paseo 0.13 persisted tab state. */
export function FactoryPanel({ theme, layout, navigation, host, workspaceId, tab }: PluginWorkspacePanelProps) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  return <FactoryShell theme={theme} layout={layout} dir={dir ?? undefined} navigation={navigation} serverId={host.id} panelTab={tab} />;
}
