/**
 * The Integrations screen's write journeys (T-09b): the Owner's plugin acts
 * through their transport slots — the header's Check-for-updates probe
 * (`factory.plugins.check.updates`, no confirm) and the per-card acts
 * (`factory.plugins.install` for a not-installed companion or tool,
 * `factory.plugins.manage` enable/disable/update). EVERY install/manage
 * opens the one confirm dialog naming the plugin and the act; Cancel sends
 * nothing, and the confirm sends exactly the act's input — a `{target}` for
 * install, a `{pluginId, action}` for manage, never a developer field. Every
 * reply arm renders verbatim as data: the success banner carries the
 * handler's own `summary` and fires the shell's refresh (`onChanged`), a
 * refusal carries its code and sentence with the dialog kept for another
 * try. The visibility rules are the fold's own facts: the Core card offers
 * Update only when the check marked it (never Install/Enable/Disable), a
 * tool offers Install/Update only, a companion earns its full set, and
 * every control disables while a write is in flight.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView } from "../../../plugin/shared/view.ts";
import type { PluginsCheckUpdatesReply, PluginsInstallReply, PluginsManageReply } from "../plugins.ts";
import { fixtureView } from "../test/fixture-view.ts";
import { IntegrationsScreen } from "./integrations.tsx";

afterEach(() => {
  cleanup();
});

/** A companion card's minimal honest slice — every optional field null unless named. */
function pluginCard(id: string, over: Partial<FactoryView["companions"][number]> = {}): FactoryView["companions"][number] {
  return {
    id,
    title: id === "factory-burn-lab" ? "Burn Lab" : id === "factory-release-lab" ? "Release Lab" : id === "factory-skills-pack" ? "Factory Skills Pack" : id,
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

/** The write roster: a stale tool, a running companion, a missing companion — and a clean Core card. */
const writeView = (): FactoryView => {
  const view = fixtureView();
  view.companionTools = [pluginCard("factory-skills-pack", { status: "running", enabled: true, installKind: "git", version: "1.4.2", updateAvailable: true, commitsBehind: 3 })];
  view.companions = [
    pluginCard("factory-burn-lab", { status: "running", enabled: true, installKind: "git", version: "0.3.1", updateAvailable: false }),
    pluginCard("factory-release-lab", { status: "not_installed" }),
  ];
  return view;
};

/** The same roster with the companion disabled — the Enable act's own facts. */
const disabledCompanionView = (): FactoryView => {
  const view = writeView();
  view.companions = [pluginCard("factory-burn-lab", { status: "disabled", enabled: false, version: "0.3.1" }), pluginCard("factory-release-lab")];
  return view;
};

/** The roster with the Core card itself marked stale by a check — the one act the Core card can ever offer. */
const staleCoreView = (): FactoryView => {
  const view = writeView();
  view.corePlugin = { ...view.corePlugin, installKind: "git", updateAvailable: true, commitsBehind: 4 };
  return view;
};

/** The tool honestly missing — a tool earns Install, never Enable/Disable. */
const missingToolView = (): FactoryView => {
  const view = writeView();
  view.companionTools = [pluginCard("factory-skills-pack", { status: "not_installed" })];
  return view;
};

const card = (name: string) => screen.getByRole("article", { name: name });

describe("the confirm gate — every install and manage", () => {
  it("opens the confirm naming the plugin and the act — Cancel sends nothing and closes", async () => {
    const pluginsInstall = vi.fn(async (): Promise<PluginsInstallReply> => ({ ok: true, installed: ["factory-release-lab"], summary: "installed factory-release-lab" }));
    render(<IntegrationsScreen view={writeView()} pluginsInstall={pluginsInstall} />);
    fireEvent.click(screen.getByRole("button", { name: "Install Release Lab" }));
    const dialog = screen.getByRole("dialog", { name: "Install Release Lab?" });
    // The dialog names the plugin and states the honest outcome — the canonical source, the roster refresh.
    expect(within(dialog).getByText(/installs Release Lab from its canonical source/)).toBeTruthy();
    expect(within(dialog).getByText("factory-release-lab")).toBeTruthy();
    // Cancel closes — nothing was sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(pluginsInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Confirm sends exactly the target for an install — the handler's sentence renders and the shell refreshes", async () => {
    const pluginsInstall = vi.fn(async (): Promise<PluginsInstallReply> => ({ ok: true, installed: ["factory-release-lab"], summary: "installed factory-release-lab from git:daymanondev/factory-release-lab:plugin and enabled it" }));
    const onChanged = vi.fn();
    render(<IntegrationsScreen view={writeView()} pluginsInstall={pluginsInstall} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Install Release Lab" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Install Release Lab?" })).getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(pluginsInstall).toHaveBeenCalledTimes(1));
    expect(pluginsInstall).toHaveBeenCalledWith({ target: "factory-release-lab" });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Installing Release Lab");
    expect(status.textContent).toContain("installed factory-release-lab from git:daymanondev/factory-release-lab:plugin and enabled it");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the Update act sends pluginId and action update — for the tool the check marked", async () => {
    const pluginsManage = vi.fn(async (): Promise<PluginsManageReply> => ({ ok: true, pluginId: "factory-skills-pack", action: "update", summary: "updated factory-skills-pack — 3 commits applied" }));
    const onChanged = vi.fn();
    render(<IntegrationsScreen view={writeView()} pluginsManage={pluginsManage} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Update Factory Skills Pack" }));
    const dialog = screen.getByRole("dialog", { name: "Update Factory Skills Pack?" });
    expect(within(dialog).getByText(/3 commits behind/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Update plugin" }));
    await waitFor(() => expect(pluginsManage).toHaveBeenCalledTimes(1));
    expect(pluginsManage).toHaveBeenCalledWith({ pluginId: "factory-skills-pack", action: "update" });
    expect((await screen.findByRole("status")).textContent).toContain("updated factory-skills-pack — 3 commits applied");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("the Disable act confirms with the danger face and sends pluginId and action disable", async () => {
    const pluginsManage = vi.fn(async (): Promise<PluginsManageReply> => ({ ok: true, pluginId: "factory-burn-lab", action: "disable", summary: "disabled factory-burn-lab" }));
    render(<IntegrationsScreen view={writeView()} pluginsManage={pluginsManage} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable Burn Lab" }));
    const dialog = screen.getByRole("dialog", { name: "Disable Burn Lab?" });
    expect(within(dialog).getByText(/Nothing is removed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable plugin" }));
    await waitFor(() => expect(pluginsManage).toHaveBeenCalledTimes(1));
    expect(pluginsManage).toHaveBeenCalledWith({ pluginId: "factory-burn-lab", action: "disable" });
  });

  it("the Enable act offers a disabled companion — sends pluginId and action enable", async () => {
    const pluginsManage = vi.fn(async (): Promise<PluginsManageReply> => ({ ok: true, pluginId: "factory-burn-lab", action: "enable", summary: "enabled factory-burn-lab" }));
    render(<IntegrationsScreen view={disabledCompanionView()} pluginsManage={pluginsManage} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable Burn Lab" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Enable Burn Lab?" })).getByRole("button", { name: "Enable plugin" }));
    await waitFor(() => expect(pluginsManage).toHaveBeenCalledTimes(1));
    expect(pluginsManage).toHaveBeenCalledWith({ pluginId: "factory-burn-lab", action: "enable" });
  });

  it("renders a refusal verbatim and keeps the dialog for another try", async () => {
    const pluginsManage = vi.fn(async (): Promise<PluginsManageReply> => ({
      ok: false,
      code: "forbidden_operation",
      error: "factory.plugins.manage refuses action disable for paseo-factory from the console — the console's own host plugin cannot be disabled here",
    }));
    render(<IntegrationsScreen view={writeView()} pluginsManage={pluginsManage} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable Burn Lab" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Disable Burn Lab?" })).getByRole("button", { name: "Disable plugin" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (forbidden_operation)");
    expect(alert.textContent).toContain("the console's own host plugin cannot be disabled here");
    // The dialog reverted to its confirm step — the act can be retried or cancelled.
    const dialog = screen.getByRole("dialog", { name: "Disable Burn Lab?" });
    expect(within(dialog).getByRole("button", { name: "Disable plugin" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(pluginsManage).toHaveBeenCalledTimes(1);
  });
});

describe("Check for updates — the probe needs no confirm", () => {
  it("sends {} immediately — the reply renders verbatim and the shell refreshes", async () => {
    const pluginsCheckUpdates = vi.fn(async (): Promise<PluginsCheckUpdatesReply> => ({
      ok: true,
      checkedAt: "2026-11-08T10:15:00.000Z",
      updatesAvailable: ["factory-skills-pack"],
      summary: "1 plugin update(s) available: factory-skills-pack",
    }));
    const onChanged = vi.fn();
    render(<IntegrationsScreen view={writeView()} pluginsCheckUpdates={pluginsCheckUpdates} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(pluginsCheckUpdates).toHaveBeenCalledTimes(1));
    expect(pluginsCheckUpdates).toHaveBeenCalledWith({});
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Checking for plugin updates");
    expect(status.textContent).toContain("1 plugin update(s) available: factory-skills-pack");
    expect(onChanged).toHaveBeenCalledTimes(1);
    // A read-only probe — no dialog ever opened.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a daemon failure verbatim too", async () => {
    const pluginsCheckUpdates = vi.fn(async (): Promise<PluginsCheckUpdatesReply> => ({ ok: false, code: "daemon_failed", error: "paseo daemon unreachable" }));
    render(<IntegrationsScreen view={writeView()} pluginsCheckUpdates={pluginsCheckUpdates} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (daemon_failed)");
    expect(alert.textContent).toContain("paseo daemon unreachable");
  });
});

describe("the acts the fold's facts earn", () => {
  it("the Core card offers Update only when a check marked it — never Install, Enable, or Disable", () => {
    render(<IntegrationsScreen view={staleCoreView()} />);
    const core = card("Paseo Factory plugin");
    expect(within(core).getByRole("button", { name: "Update Paseo Factory" })).toBeTruthy();
    for (const word of ["Install", "Enable", "Disable"]) {
      expect(within(core).queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
    }
  });

  it("a clean Core card carries no act at all", () => {
    render(<IntegrationsScreen view={writeView()} />);
    expect(within(card("Paseo Factory plugin")).queryAllByRole("button")).toEqual([]);
  });

  it("a tool earns Install and Update only — never Enable or Disable, even while running", () => {
    const missingRender = render(<IntegrationsScreen view={missingToolView()} />);
    const missing = card("Factory Skills Pack plugin");
    expect(within(missing).getByRole("button", { name: "Install Factory Skills Pack" })).toBeTruthy();
    missingRender.unmount();
    render(<IntegrationsScreen view={writeView()} />);
    const running = card("Factory Skills Pack plugin");
    expect(within(running).getByRole("button", { name: "Update Factory Skills Pack" })).toBeTruthy();
    for (const cardEl of [missing, running]) {
      for (const word of ["Enable", "Disable", "Remove", "Reload"]) {
        expect(within(cardEl).queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
      }
    }
  });

  it("a companion earns its full set — Install while missing, Disable while enabled, Enable while disabled, nothing more", () => {
    const enabledRender = render(<IntegrationsScreen view={writeView()} />);
    const missing = card("Release Lab plugin");
    expect(within(missing).getByRole("button", { name: "Install Release Lab" })).toBeTruthy();
    expect(within(missing).queryByRole("button", { name: /Disable/i })).toBeNull();
    const running = card("Burn Lab plugin");
    expect(within(running).getByRole("button", { name: "Disable Burn Lab" })).toBeTruthy();
    enabledRender.unmount();
    render(<IntegrationsScreen view={disabledCompanionView()} />);
    expect(within(card("Burn Lab plugin")).getByRole("button", { name: "Enable Burn Lab" })).toBeTruthy();
  });

  it("disables every act while a write is in flight", async () => {
    let release: (() => void) | undefined;
    const pluginsCheckUpdates = vi.fn(
      () =>
        new Promise<PluginsCheckUpdatesReply>((resolve) => {
          release = () => resolve({ ok: true, checkedAt: "2026-11-08T10:15:00.000Z", updatesAvailable: [], summary: "All installed Factory plugins are up to date." });
        }),
    );
    render(<IntegrationsScreen view={writeView()} pluginsCheckUpdates={pluginsCheckUpdates} />);
    const install = screen.getByRole("button", { name: "Install Release Lab" });
    expect(install.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(pluginsCheckUpdates).toHaveBeenCalledTimes(1));
    expect(install.hasAttribute("disabled"), "the install disabled while the probe is in flight").toBe(true);
    expect(screen.getByRole("button", { name: "Check for updates" }).hasAttribute("disabled")).toBe(true);
    release!();
    await waitFor(() => expect(install.hasAttribute("disabled")).toBe(false));
  });
});
