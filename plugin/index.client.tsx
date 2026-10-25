/**
 * paseo-factory's client entry (v0.0.13, ADR 0009 §1) — the Factory surface.
 * Four contributions, one <FactoryShell />: the global screen + sidebar
 * header item, the workspace panel (explorer + workspace locations), and the
 * settings screen. The daemon discovers this file by filename convention
 * (`index.client.tsx`) — the manifest declares no client entry. The bundle
 * boundary (no node built-ins, no class syntax — Hermes) is enforced by
 * scripts/check-bundle.mjs.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { retro, vaultSync } from "./shared/rpc.ts";
import { FactoryPanel, FactoryScreen, FactorySettings, FactorySidebarItem, PANEL_ID, SCREEN_ID } from "./client/factory/entries.tsx";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "Factory", Component: FactoryScreen }),
    client.addSidebarHeaderItem({ id: "paseo-factory", title: "Factory", Component: FactorySidebarItem }),
    client.addWorkspacePanel({
      id: PANEL_ID,
      title: "Factory",
      icon: "Activity",
      locations: ["explorer", "workspace"],
      Component: FactoryPanel,
    }),
    client.addSettingsScreen({ id: "paseo-factory", title: "Factory", icon: "Settings2", Component: FactorySettings }),
    client.addCommandCenterItem({
      id: "factory-open-screen",
      title: "Factory: Open Verification Board",
      icon: "Activity",
      keywords: ["factory", "kanban", "tasks", "slp", "verification"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addCommandCenterItem({
      id: "factory-open-panel",
      title: "Factory: Open Workspace Panel",
      icon: "Activity",
      keywords: ["factory", "panel", "kanban", "workspace"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addCommandCenterItem({
      id: "factory-run-retro",
      title: "Factory: Run Daily Retro",
      icon: "Sparkles",
      keywords: ["factory", "retro", "proposals"],
      context: "global",
      async onSelect({ rpc, openScreen }) {
        await rpc(retro, {});
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addCommandCenterItem({
      id: "factory-sync-vault",
      title: "Factory: Sync Private Vault",
      icon: "CloudUpload",
      keywords: ["factory", "vault", "sync"],
      context: "global",
      async onSelect({ rpc, openScreen }) {
        await rpc(vaultSync, {});
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const off of cleanups) off();
  };
}
