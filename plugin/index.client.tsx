/**
 * paseo-factory's client entry (v0.0.13, ADR 0009 §1; v0.6.0 W4, ADR 0056;
 * ADR 0068) — the Factory surface:
 * - workspace panel (explorer + workspace locations)
 * - Settings screen
 * - Command Center actions (`Open Factory Panel`, `Factory: Onboard Project` on desktop)
 * - seat-directory starter (`startSeatDirectory`, header buttons + composer pills + workspace badges)
 * - desktop-only single `Factory` sidebar header item opening `Factory overview` (`paseo-factory-overview`)
 *   plus the global `Onboarding` screen route (`paseo-factory-onboard`) reachable from Overview / Command Center.
 *
 * The daemon discovers this file by filename convention (`index.client.tsx`)
 * — the manifest declares no client entry. The bundle boundary (no node
 * built-ins, no class syntax — Hermes) is enforced by scripts/check-bundle.mjs.
 */
import type { PluginClientContext, PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import {
  FactoryOnboardScreen,
  FactoryOverviewScreen,
  FactoryOverviewSidebarItem,
  FactoryPanel,
  FactorySettings,
  ONBOARD_SCREEN_ID,
  OVERVIEW_SCREEN_ID,
  PANEL_ID,
} from "./client/factory/entries.tsx";
import { createSeatEditorRequests } from "./client/factory/editor-request.ts";
import { startSeatDirectory } from "./client/factory/directory.tsx";

export default function contribute(client: PluginClientContext) {
  const editorRequests = createSeatEditorRequests();
  const mobile = Platform.OS === "ios" || Platform.OS === "android";
  const cleanups = [
    client.addWorkspacePanel({
      id: PANEL_ID,
      title: "Factory",
      icon: "Activity",
      locations: ["explorer", "workspace"],
      Component: (props) => (
        <FactoryPanel
          {...props}
          editorRequests={editorRequests}
          openSettings={() => client.openSettings("paseo-factory")}
          {...(mobile
            ? {}
            : {
                openReleaseLab: () => {
                  if (typeof (client as { openScreen?: unknown }).openScreen === "function") {
                    client.openScreen({ screenId: "factory-release-lab" });
                    return;
                  }
                  client.openPanel?.("factory-release-lab", { workspaceId: props.workspaceId, location: "workspace" });
                },
              })}
        />
      ),
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
    startSeatDirectory(client, editorRequests),
  ];
  if (!mobile) {
    if (typeof (client as { addSidebarHeaderItem?: unknown }).addSidebarHeaderItem === "function") {
      cleanups.push(
        client.addSidebarHeaderItem({
          id: OVERVIEW_SCREEN_ID,
          title: "Factory",
          Component: FactoryOverviewSidebarItem,
        }),
      );
    }
    if (typeof (client as { addScreen?: unknown }).addScreen === "function") {
      cleanups.push(
        client.addScreen({
          id: OVERVIEW_SCREEN_ID,
          title: "Factory",
          Component: (props) => (
            <FactoryOverviewScreen
              {...props}
              openPanel={(id, options) => client.openPanel?.(id, options)}
              openScreen={(input: PluginOpenScreenInput) => {
                if (typeof (client as { openScreen?: unknown }).openScreen === "function") {
                  client.openScreen(input);
                }
              }}
            />
          ),
        }),
      );
      cleanups.push(
        client.addScreen({
          id: ONBOARD_SCREEN_ID,
          title: "Onboard Project",
          Component: (props) => (
            <FactoryOnboardScreen
              {...props}
              openPanel={(id, options) => client.openPanel?.(id, options)}
            />
          ),
        }),
      );
    }
    cleanups.push(
      client.addCommandCenterItem({
        id: "factory-onboard-project",
        title: "Factory: Onboard Project",
        icon: "FolderPlus",
        keywords: ["factory", "onboard", "project", "setup", "wizard"],
        context: "global",
        onSelect({ openScreen }) {
          if (Platform.OS === "ios" || Platform.OS === "android") return;
          openScreen({ screenId: ONBOARD_SCREEN_ID });
        },
      }),
    );
  }
  return () => {
    for (const off of cleanups) off();
  };
}
