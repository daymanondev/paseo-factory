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
import { FactoryPanel, FactoryScreen, FactorySettings, FactorySidebarItem, SCREEN_ID } from "./client/factory/entries.tsx";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "Factory", Component: FactoryScreen }),
    client.addSidebarHeaderItem({ id: "paseo-factory", title: "Factory", Component: FactorySidebarItem }),
    client.addWorkspacePanel({
      id: "paseo-factory",
      title: "Factory",
      icon: "Activity",
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: FactoryPanel,
    }),
    client.addSettingsScreen({ id: "paseo-factory", title: "Factory", icon: "Settings2", Component: FactorySettings }),
  ];
  return () => {
    for (const off of cleanups) off();
  };
}
