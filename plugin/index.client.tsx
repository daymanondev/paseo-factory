/**
 * paseo-factory's client entry (v0.0.13, ADR 0009 §1; v0.6.0 W4, ADR 0056) —
 * the Factory surface. Three contributions, one <FactoryShell />: the
 * workspace panel (explorer + workspace locations), the settings screen, and
 * one Command Center action that opens the panel. The global screen, the
 * sidebar header item and every other palette action are gone.
 * v0.6.1 (W4 spike, ADR 0057 §8/§11) adds the seat-directory starter: a
 * 20-second `factory.seats.directory` poll that registers one header button
 * per Project root workspace and one read-only composer pill per live seat
 * agent — the first app-wide contributions since the slim-down, and the only
 * door through which they register.
 * The daemon discovers this file by filename convention (`index.client.tsx`)
 * — the manifest declares no client entry. The bundle boundary (no node
 * built-ins, no class syntax — Hermes) is enforced by scripts/check-bundle.mjs.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FactoryPanel, FactorySettings, PANEL_ID } from "./client/factory/entries.tsx";
import { startSeatDirectory } from "./client/factory/directory.tsx";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addWorkspacePanel({
      id: PANEL_ID,
      title: "Factory",
      icon: "Activity",
      locations: ["explorer", "workspace"],
      Component: (props) => <FactoryPanel {...props} openSettings={() => client.openSettings("paseo-factory")} />,
    }),
    client.addSettingsScreen({ id: "paseo-factory", title: "Factory", icon: "Settings2", Component: FactorySettings }),
    client.addCommandCenterItem({
      id: "factory-open-panel",
      title: "Open Factory Panel",
      icon: "Activity",
      keywords: ["factory", "panel", "workspace", "slp", "verification"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    startSeatDirectory(client),
  ];
  return () => {
    for (const off of cleanups) off();
  };
}
