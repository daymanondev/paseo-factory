/**
 * The surface's two hosts (ADR 0009 §1; v0.6.0 W4/W8, ADR 0056): the workspace
 * panel (the Project panel, scoped to the active workspace's directory via
 * useWorkspace) and the Settings screen (machine-wide, unscoped) — both
 * rendering the one FactoryShell. The global screen and the sidebar header
 * item are gone.
 */
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { FactoryShell } from "./shell.tsx";
import { FactoryTabErrorBoundary } from "./tab-error-boundary.tsx";

export const PANEL_ID = "paseo-factory";

/** The Settings screen: collapsible machine-wide sections — models & Lane profiles, skills & tools, plugins, Vault, diagnostics. */
export function FactorySettings({ theme, layout, navigation, host }: PluginSurfaceProps) {
  return <FactoryShell theme={theme} layout={layout} navigation={navigation} serverId={host.id} surface="settings" />;
}

/** The workspace panel: the Project panel scoped to this workspace's directory. */
export function FactoryPanel({ theme, layout, navigation, host, workspaceId, openSettings }: PluginWorkspacePanelProps & { openSettings?: () => void }) {
  const dir = useWorkspace(workspaceId, (workspace) => workspace.directory);
  return <FactoryTabErrorBoundary theme={theme} section="Factory tab"><FactoryShell theme={theme} layout={layout} dir={dir ?? undefined} navigation={navigation} serverId={host.id} {...(openSettings === undefined ? {} : { openSettings })} /></FactoryTabErrorBoundary>;
}
