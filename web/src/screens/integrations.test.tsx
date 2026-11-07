/**
 * The Integrations screen's contract (T-09a): the `/integrations` route
 * renders the READ-ONLY integrations roster from the snapshot alone — the
 * plugin cards (Core first, then companion tools, then the catalog
 * companions, each with its status word, version, and on-demand update
 * state), the host skill ecosystem's linked-vs-available rows, the Helper
 * MCP roster's name/transport/health, the scoped Project's Open Design
 * link (or the honest "Not linked"), and the plugins-checked-at stamp (or
 * "Never checked"). The boundary is the wave's own law: NO writes render —
 * no Install/Manage, no update buttons, no Check-updates, no dialogs
 * (T-09b) — and no Start Supervisor/Lead anywhere (ADR 0017). The three
 * tabs are a client-side view switch, never an RPC door.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";

/** The roster rows' shapes — indexed off the view the way the fold itself does. */
type HelperMcpRow0 = NonNullable<FactoryView["helperMcps"]>[number];
type HostItem0 = NonNullable<FactoryView["skillHub"]>["hostCatalog"][number];
import { fixtureView } from "../test/fixture-view.ts";
import { integrationsScreenModel, utcStamp } from "../integrations-view.ts";
import { IntegrationsScreen } from "./integrations.tsx";

afterEach(() => {
  cleanup();
});

// ---- the fixture views ---------------------------------------------------------------------------

/** A companion card's minimal honest slice — every optional field null unless named. */
function pluginCard(id: string, over: Partial<FactoryView["companions"][number]> = {}): FactoryView["companions"][number] {
  return {
    id,
    title: id.replace(/-/g, " "),
    tagline: "",
    description: `The ${id} companion.`,
    canonicalSource: "https://github.com/andrew/paseo-factory",
    sidebarLabel: id,
    sidebarIcon: "factory",
    capabilities: [],
    access: "public",
    status: "not_installed",
    enabled: false,
    installKind: null,
    installedSource: null,
    currentRevision: null,
    version: null,
    latestRevision: null,
    commitsBehind: null,
    updateAvailable: null,
    error: null,
    ...over,
  };
}

/** One host-catalog row — the skill hub's own shape. */
function hostItem(id: string, over: Partial<HostItem0> = {}): HostItem0 {
  return { id, name: id, ecosystem: "zcode", path: null, skills: [], status: "available", kind: "pack", mcpServers: [], ...over };
}

/** One helper MCP row — the roster's own shape. */
function helperMcp(name: string, over: Partial<HelperMcpRow0> = {}): HelperMcpRow0 {
  return { name, transport: "stdio", enabled: false, targetProviders: [], vaultSync: false, sources: ["factory"], status: "disabled", ...over };
}

/** The rich view — one tool with an update, two companions, three ecosystems, two MCPs, a linked Open Design project, a checked-at stamp. */
const richView = (): FactoryView => {
  const view = fixtureView();
  view.companionTools = [
    pluginCard("factory-skills-pack", { title: "Factory Skills Pack", status: "running", enabled: true, installKind: "git", version: "v1.4.2", updateAvailable: true, commitsBehind: 3 }),
  ];
  view.companions = [
    pluginCard("factory-burn-lab", { title: "Burn Lab", status: "running", enabled: true, installKind: "git", version: "0.3.1", updateAvailable: false }),
    pluginCard("factory-release-lab", { title: "Release Lab", status: "not_installed" }),
  ];
  view.skillHub = {
    totalInstalled: 2,
    upToDateCount: 2,
    updateAvailableCount: 0,
    localCustomCount: 0,
    symlinkDriftCount: 0,
    installedSkills: [],
    projectPacks: [],
    hostCatalog: [
      hostItem("expo:official-pack", { name: "Official Expo & EAS", ecosystem: "GitHub Catalog (expo/skills)", skills: ["eas-app-stores", "eas-hosting"], status: "linked", kind: "pack", mcpServers: ["expo-mcp"] }),
      hostItem("zcode:asc-iap", { name: "asc-iap", skills: ["asc-iap"], status: "available", kind: "skill" }),
      hostItem("codex:some-cli", { name: "some-cli", skills: [], status: "available", kind: "plugin", mcpServers: ["some-mcp"] }),
    ],
    roleMatrix: [],
  };
  view.helperMcps = [
    helperMcp("my-helper", { enabled: true, status: "connected", statusDetail: "Command and credentials present; server starts on first use" }),
    helperMcp("figma", { enabled: true, status: "missing_env", statusDetail: "Missing credentials: FIGMA_API_KEY" }),
    helperMcp("open-design", { status: "disabled" }),
  ];
  view.execution = {
    selectedMode: "slp",
    revision: 1,
    openDesignLink: {
      projectId: "design-1",
      projectName: "Factory workspace redesign",
      sourceUpdatedAt: 1762582800,
      syncedAt: "2026-11-08T06:00:00.000Z",
      digest: "abc123def456abc123def456abc123def456",
      screenCount: 14,
      files: [],
    },
  };
  view.pluginsCheckedAt = "2026-11-08T07:30:00.000Z";
  return view;
};

// ---- the fold (pure) -------------------------------------------------------------------------------

describe("the integrations fold (pure)", () => {
  it("folds the plugin roster — Core coral-first, the tools, then the catalog, with the RN status words", () => {
    const model = integrationsScreenModel(richView());
    expect(model.plugins.map((row) => [row.id, row.tone, row.core])).toEqual([
      ["paseo-factory", "coral", true],
      ["factory-skills-pack", "lime", false],
      ["factory-burn-lab", "cyan", false],
      ["factory-release-lab", "cyan", false],
    ]);
    const core = model.plugins[0]!;
    expect(core.statusLabel).toBe("Running");
    expect(core.statusTone).toBe("green");
    expect(core.versionLabel).toBe("v0.2.3");
    expect(core.updateAvailable).toBeNull();
    const tool = model.plugins[1]!;
    expect(tool.versionLabel).toBe("v1.4.2");
    expect(tool.updateAvailable).toBe(true);
    expect(tool.commitsBehind).toBe(3);
    const burn = model.plugins[2]!;
    expect(burn.updateAvailable).toBe(false);
    const release = model.plugins[3]!;
    expect(release.statusLabel).toBe("Not Installed");
    expect(release.statusTone).toBe("muted");
    expect(release.versionLabel).toBeNull();
    expect(model.updateCount).toBe(1);
  });

  it("carries the failed and disabled plugin faces", () => {
    const view = fixtureView();
    view.companions = [
      pluginCard("factory-burn-lab", { status: "failed", error: "boom" }),
      pluginCard("factory-release-lab", { status: "disabled", enabled: false, version: "0.1.0" }),
    ];
    const model = integrationsScreenModel(view);
    expect(model.plugins[1]!.statusLabel).toBe("Failed");
    expect(model.plugins[1]!.statusTone).toBe("red");
    expect(model.plugins[2]!.statusLabel).toBe("Disabled");
    expect(model.plugins[2]!.statusTone).toBe("amber");
  });

  it("folds the host skill ecosystems verbatim — linked vs available in the hub's own vocabulary", () => {
    const model = integrationsScreenModel(richView());
    expect(model.skills.map((row) => [row.name, row.status, row.kind])).toEqual([
      ["Official Expo & EAS", "linked", "pack"],
      ["asc-iap", "available", "skill"],
      ["some-cli", "available", "plugin"],
    ]);
    expect(model.skills[0]!.skills).toEqual(["eas-app-stores", "eas-hosting"]);
    expect(model.skills[0]!.mcpServers).toEqual(["expo-mcp"]);
    expect(integrationsScreenModel(fixtureView()).skills).toEqual([]);
  });

  it("folds the Helper MCP roster — the RN health words, 'Local on Host' for the disabled half", () => {
    const model = integrationsScreenModel(richView());
    expect(model.mcps.map((row) => [row.name, row.transport, row.statusLabel, row.statusTone])).toEqual([
      ["my-helper", "stdio", "Connected", "green"],
      ["figma", "stdio", "Missing Key", "amber"],
      ["open-design", "stdio", "Local on Host", "muted"],
    ]);
    expect(model.mcps[1]!.statusDetail).toBe("Missing credentials: FIGMA_API_KEY");
    expect(integrationsScreenModel(fixtureView()).mcps).toEqual([]);
  });

  it("folds the Open Design link — stamped in deterministic UTC, the digest shortened", () => {
    const link = integrationsScreenModel(richView()).openDesign!;
    expect(link.projectName).toBe("Factory workspace redesign");
    expect(link.screenCount).toBe(14);
    expect(link.syncedAtLabel).toBe("2026-11-08 06:00 UTC");
    expect(link.digestShort).toBe("abc123def456");
    expect(link.digest).toBe("abc123def456abc123def456abc123def456");
    const bare = fixtureView();
    bare.execution = { selectedMode: "slp", revision: 1 };
    expect(integrationsScreenModel(bare).openDesign).toBeNull();
    expect(integrationsScreenModel(fixtureView()).openDesign).toBeNull();
  });

  it("answers the checked-at stamp honestly — 'Never checked' when the daemon has not run one", () => {
    expect(integrationsScreenModel(fixtureView()).pluginsCheckedAtLabel).toBe("Never checked");
    const model = integrationsScreenModel(richView());
    expect(model.pluginsCheckedAtLabel).toBe("Checked 2026-11-08 07:30 UTC");
    expect(model.pluginsCheckedAt).toBe("2026-11-08T07:30:00.000Z");
  });

  it("stamps UTC by string law — never a locale drift between jsdom, node, and the browser", () => {
    expect(utcStamp("2026-11-08T06:00:00.000Z")).toBe("2026-11-08 06:00 UTC");
    expect(utcStamp("not-a-date")).toBe("not-a-date");
  });

  it("scopes to the selected Project's name, 'All projects' unscoped", () => {
    expect(integrationsScreenModel(fixtureView()).scope).toBe("All projects");
    const scoped = richView();
    scoped.project = { ...scoped.projects[0]!, executionMode: "slp" };
    expect(integrationsScreenModel(scoped).scope).toBe("research-slp");
  });
});

// ---- the screen ------------------------------------------------------------------------------------

describe("the Integrations screen", () => {
  it("renders the heading, the checked-at line, and the Core plugin card from the snapshot", () => {
    render(<IntegrationsScreen view={richView()} />);
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByText("All projects · Plugin updates: Checked 2026-11-08 07:30 UTC")).toBeTruthy();
    const core = screen.getByRole("article", { name: "Paseo Factory plugin" });
    expect(screen.getByText("Paseo Factory · Core")).toBeTruthy();
    expect(within(core).getByText("Running")).toBeTruthy();
    expect(within(core).getByText("v0.2.3")).toBeTruthy();
  });

  it("says 'Never checked' when no update check has run", () => {
    render(<IntegrationsScreen view={fixtureView()} />);
    expect(screen.getByText("All projects · Plugin updates: Never checked")).toBeTruthy();
  });

  it("switches its three read-only tabs client-side — plugins, skills, MCP servers", () => {
    render(<IntegrationsScreen view={richView()} />);
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    expect(screen.getByText("Official Expo & EAS")).toBeTruthy();
    expect(screen.getByText("2 skills · eas-app-stores, eas-hosting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /MCP servers/ }));
    expect(screen.getByRole("heading", { name: "my-helper" })).toBeTruthy();
    expect(screen.getByText("Local on Host")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Plugins & tools/ }));
    expect(screen.getByText("Factory Skills Pack")).toBeTruthy();
  });

  it("renders the update state as honest text — the amber word, the commits behind, the tab's dot", () => {
    render(<IntegrationsScreen view={richView()} />);
    expect(screen.getByText("Update available · 3 commits behind")).toBeTruthy();
    expect(screen.getByTitle("1 update available")).toBeTruthy();
    const upToDate = screen.getByRole("article", { name: "Burn Lab plugin" });
    expect(within(upToDate).getByText("Up to date")).toBeTruthy();
  });

  it("answers each section's honest empty state", () => {
    render(<IntegrationsScreen view={fixtureView()} />);
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    expect(screen.getByText("No skill ecosystems discovered on this host.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /MCP servers/ }));
    expect(screen.getByText("No Helper MCP servers discovered.")).toBeTruthy();
  });

  it("renders the linked Open Design card — project, screens, synced-at, digest", () => {
    render(<IntegrationsScreen view={richView()} />);
    expect(screen.getByRole("heading", { name: "Factory workspace redesign" })).toBeTruthy();
    expect(screen.getByText("OPEN DESIGN LINK")).toBeTruthy();
    expect(screen.getByText("Synced at")).toBeTruthy();
    expect(screen.getByText("2026-11-08 06:00 UTC")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("abc123def456")).toBeTruthy();
  });

  it("answers the honest 'Not linked' when the Project carries no Open Design link", () => {
    render(<IntegrationsScreen view={fixtureView()} />);
    expect(screen.getByText("Not linked", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText(/carries no Open Design link/)).toBeTruthy();
  });

  it("renders the daemon-degraded line when the daemon half failed", () => {
    const view = richView();
    view.daemonError = "paseo daemon unreachable";
    render(<IntegrationsScreen view={view} />);
    expect(screen.getByText(/Live integration states are degraded \(paseo daemon unreachable\)/)).toBeTruthy();
  });

  it("carries no writes — no Install/Manage/Update buttons, no Check-updates, no dialogs, no Start seats (ADR 0017)", () => {
    render(<IntegrationsScreen view={richView()} />);
    // The only buttons on the screen are the three tabs — a client-side view switch, never an RPC door.
    const buttons = screen.queryAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Plugins & tools4", "Skills3", "MCP servers3"]);
    // "Update" is absent from the scan on purpose: the Plugins tab's own update
    // dot announces "1 update available" — honest read-only state, not a control.
    for (const word of ["Install", "Manage", "Check for updates", "Check updates", "Sync", "Verify", "Start Supervisor", "Start Lead"]) {
      expect(screen.queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
    }
  });
});
