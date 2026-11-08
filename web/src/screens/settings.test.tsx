/**
 * The Settings screen's contract (T-10a + T-10b + T-10d): the `/settings` route renders the
 * read-only Private Vault card and the scoped Project card from the snapshot
 * alone — the configured face first, the repo/branch/node facts, the
 * passphrase as a boolean and the clone as a presence, the hydrate/push
 * stamps in deterministic UTC or "Never", the four shared-secret presence
 * chips (never values), the hydrated apps list, and the gh probe's
 * installed/login/user/suggested line inside the diagnostics disclosure.
 * T-10b adds the first three vault acts (Configure, Pull, Push), T-10c the
 * two round-trips (Sync, Hydrate), and T-10d the key import behind its
 * dialog (the write journeys live in settings-write.test.tsx,
 * settings-sync.test.tsx, and settings-import.test.tsx); the rest of
 * the wave's boundary law holds: no project reset/delete (T-10e), no
 * seat start (ADR 0017), and no credential or passphrase text ever
 * reaches the DOM (the fold carries booleans only, so there is nothing
 * to leak).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryView, VaultStatusView } from "../../../plugin/shared/view.ts";
import { fixtureView } from "../test/fixture-view.ts";
import { settingsScreenModel } from "../settings-view.ts";
import { SettingsScreen } from "./settings.tsx";

afterEach(() => {
  cleanup();
});

// ---- the fixture views ---------------------------------------------------------------------------

/** A vault half — every field honest, the shared secrets booleans only (never a value). */
function vault(over: Partial<VaultStatusView> = {}): VaultStatusView {
  return {
    configured: false,
    repo: null,
    branch: "main",
    nodeId: "node-1",
    hasPassphrase: false,
    cloneExists: false,
    lastHydratedAt: null,
    lastHydrateMode: null,
    lastPushedAt: null,
    sharedSecrets: { ascKey: false, ascCredentials: false, gplayServiceAccount: false, eyeConfig: false },
    hydratedApps: [],
    ghInstalled: false,
    ghAuthenticated: false,
    ghUser: null,
    suggestedRepo: null,
    error: null,
    ...over,
  };
}

/** The rich view — a fully configured vault mid-flight, the first Project scoped. */
const richView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({
    configured: true,
    repo: "octocat/factory-vault",
    branch: "release",
    nodeId: "andrews-mac-mini",
    hasPassphrase: true,
    cloneExists: true,
    lastHydratedAt: "2026-11-08T09:00:00.000Z",
    lastHydrateMode: "sync",
    lastPushedAt: "2026-11-08T09:05:00.000Z",
    sharedSecrets: { ascKey: true, ascCredentials: false, gplayServiceAccount: true, eyeConfig: false },
    hydratedApps: ["patigame", "patigame-web"],
    ghInstalled: true,
    ghAuthenticated: true,
    ghUser: "octocat",
    suggestedRepo: "octocat/factory-vault",
  });
  view.project = { ...view.projects[0]!, executionMode: "slp" };
  return view;
};

// ---- the fold (pure) -------------------------------------------------------------------------------

describe("the settings fold (pure)", () => {
  it("folds the unconfigured vault honestly — Not configured, Never, no secrets, no gh", () => {
    const model = settingsScreenModel(fixtureView());
    expect(model.scope).toBe("All projects");
    const vaultPanel = model.vault;
    expect(vaultPanel.configured).toBe(false);
    expect(vaultPanel.configuredLabel).toBe("Not configured");
    expect(vaultPanel.repo).toBeNull();
    expect(vaultPanel.branch).toBe("main");
    expect(vaultPanel.nodeId).toBe("node-1");
    expect(vaultPanel.passphraseLabel).toBe("Not set");
    expect(vaultPanel.cloneLabel).toBe("Absent");
    expect(vaultPanel.lastHydratedAt).toBeNull();
    expect(vaultPanel.lastHydratedLabel).toBe("Never");
    expect(vaultPanel.lastPushedAt).toBeNull();
    expect(vaultPanel.lastPushedLabel).toBe("Never");
    expect(vaultPanel.secrets.map((chip) => [chip.label, chip.present])).toEqual([
      ["ASC key", false],
      ["ASC credentials", false],
      ["Google Play", false],
      ["Eye config", false],
    ]);
    expect(vaultPanel.hydratedApps).toEqual([]);
    expect(vaultPanel.ghInstalled).toBe(false);
    expect(vaultPanel.ghAuthenticated).toBe(false);
    expect(vaultPanel.ghUser).toBeNull();
    expect(vaultPanel.suggestedRepo).toBeNull();
    expect(vaultPanel.error).toBeNull();
  });

  it("folds the configured vault — repo/branch/node, the boolean passphrase, the UTC stamps with the hydrate mode", () => {
    const model = settingsScreenModel(richView());
    const vaultPanel = model.vault;
    expect(vaultPanel.configured).toBe(true);
    expect(vaultPanel.configuredLabel).toBe("Configured");
    expect(vaultPanel.repo).toBe("octocat/factory-vault");
    expect(vaultPanel.branch).toBe("release");
    expect(vaultPanel.nodeId).toBe("andrews-mac-mini");
    expect(vaultPanel.passphraseLabel).toBe("Set");
    expect(vaultPanel.cloneLabel).toBe("Present");
    expect(vaultPanel.lastHydratedLabel).toBe("2026-11-08 09:00 UTC · sync");
    expect(vaultPanel.lastPushedLabel).toBe("2026-11-08 09:05 UTC");
    expect(vaultPanel.secrets.map((chip) => [chip.label, chip.present])).toEqual([
      ["ASC key", true],
      ["ASC credentials", false],
      ["Google Play", true],
      ["Eye config", false],
    ]);
    expect(vaultPanel.hydratedApps).toEqual(["patigame", "patigame-web"]);
    expect(vaultPanel.ghUser).toBe("octocat");
    expect(vaultPanel.suggestedRepo).toBe("octocat/factory-vault");
  });

  it("stamps a hydrate without its mode as the bare UTC word", () => {
    const view = fixtureView();
    view.vault = vault({ lastHydratedAt: "2026-11-08T09:00:00.000Z", lastHydrateMode: "direct" });
    expect(settingsScreenModel(view).vault.lastHydratedLabel).toBe("2026-11-08 09:00 UTC · direct");
    view.vault = vault({ lastHydratedAt: "2026-11-08T09:00:00.000Z" });
    expect(settingsScreenModel(view).vault.lastHydratedLabel).toBe("2026-11-08 09:00 UTC");
  });

  it("carries the gather's error through — the panel's degraded notice, never a failed screen", () => {
    const view = fixtureView();
    view.vault = vault({ error: "vault-config.json: Unexpected token" });
    expect(settingsScreenModel(view).vault.error).toBe("vault-config.json: Unexpected token");
  });

  it("folds the scoped Project — name/slug/root and the mode word — or the honest null", () => {
    const scoped = settingsScreenModel(richView());
    expect(scoped.scope).toBe("research-slp");
    expect(scoped.project).toEqual({ name: "research-slp", slug: "research-slp", root: "/Users/owner/code/research-slp", modeLabel: "SLP" });
    const scrum = richView();
    scrum.project = { ...scrum.projects[1]!, executionMode: "scrum" };
    expect(settingsScreenModel(scrum).project!.modeLabel).toBe("Agile Scrum");
    expect(settingsScreenModel(fixtureView()).project).toBeNull();
  });

  it("carries the snapshot-level daemon degradation line", () => {
    const view = fixtureView();
    view.daemonError = "paseo daemon unreachable";
    expect(settingsScreenModel(view).daemonError).toBe("paseo daemon unreachable");
  });
});

// ---- the screen ------------------------------------------------------------------------------------

describe("the Settings screen", () => {
  it("renders the heading and the honest unconfigured vault — Not configured, Never, no chips lit", () => {
    render(<SettingsScreen view={fixtureView()} />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("All projects · Private Vault + Project writes")).toBeTruthy();
    const vaultCard = screen.getByLabelText("Private vault");
    expect(screen.getByText("Not configured", { selector: "h2" })).toBeTruthy();
    expect(within(vaultCard).getAllByText("Never")).toHaveLength(2);
    expect(within(vaultCard).getByText("None hydrated yet")).toBeTruthy();
    for (const label of ["ASC key absent", "ASC credentials absent", "Google Play absent", "Eye config absent"]) {
      expect(within(vaultCard).getByLabelText(label), label).toBeTruthy();
    }
  });

  it("renders the configured vault — repo title, the stamps, the passphrase boolean, the hydrated apps", () => {
    render(<SettingsScreen view={richView()} />);
    expect(screen.getByText("octocat/factory-vault", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.getByText("Set")).toBeTruthy();
    expect(screen.getByText("2026-11-08 09:00 UTC · sync")).toBeTruthy();
    expect(screen.getByText("2026-11-08 09:05 UTC")).toBeTruthy();
    expect(screen.getByText("patigame, patigame-web")).toBeTruthy();
    expect(screen.getByLabelText("ASC key present")).toBeTruthy();
    expect(screen.getByLabelText("ASC credentials absent")).toBeTruthy();
  });

  it("opens the diagnostics disclosure client-side — Node ID, clone, gh, suggested repo", () => {
    render(<SettingsScreen view={richView()} />);
    const disclosure = screen.getByText("Vault transport details").closest("details")!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(screen.getByText("Vault transport details"));
    expect(disclosure.open).toBe(true);
    expect(screen.getByText("andrews-mac-mini")).toBeTruthy();
    expect(screen.getByText("Present")).toBeTruthy();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("renders the scoped Project card — name, slug, root, the mode badge", () => {
    render(<SettingsScreen view={richView()} />);
    expect(screen.getByText("research-slp", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText("/Users/owner/code/research-slp")).toBeTruthy();
    expect(screen.getByText("SLP")).toBeTruthy();
    expect(screen.getByText("Root")).toBeTruthy();
    expect(screen.getByText("Slug")).toBeTruthy();
  });

  it("answers the honest 'No project selected' on the unscoped global view", () => {
    render(<SettingsScreen view={fixtureView()} />);
    expect(screen.getByText("No project selected", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText(/choose a Project in the switcher/)).toBeTruthy();
  });

  it("renders the vault's degraded notice when the gather errored", () => {
    const view = fixtureView();
    view.vault = vault({ error: "vault-config.json: Unexpected token" });
    render(<SettingsScreen view={view} />);
    expect(screen.getByText(/Vault status degraded \(vault-config.json: Unexpected token\)/)).toBeTruthy();
  });

  it("renders the daemon-degraded line when the daemon half failed", () => {
    const view = richView();
    view.daemonError = "paseo daemon unreachable";
    render(<SettingsScreen view={view} />);
    expect(screen.getByText(/Live settings are degraded \(paseo daemon unreachable\)/)).toBeTruthy();
  });

  it("carries exactly the six vault acts plus the Danger Zone pair — never a seat start (T-10b + T-10c + T-10d + T-10e, ADR 0017)", () => {
    // The configured card offers Configure, Pull, Push, Sync, Hydrate, and
    // Import keys; the scoped Project's Danger Zone adds its own Reset
    // project / Delete project pair (their type-to-confirm journeys live in
    // settings-danger.test.tsx); every seat Start/Ensure control stays
    // absent; no dialog is open, so no textbox or input exists either.
    const configured = render(<SettingsScreen view={richView()} />);
    for (const name of ["Configure vault", "Pull vault", "Push vault", "Sync vault", "Hydrate vault", "Import vault keys"]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("disabled"), name).toBe(false);
    }
    for (const word of ["Start Supervisor", "Start Lead", "Ensure"]) {
      expect(screen.queryByRole("button", { name: new RegExp(word, "i") }), word).toBeNull();
    }
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(document.querySelector("input")).toBeNull();
    configured.unmount();
    // The unconfigured card keeps Configure (the setup path) and disables the
    // five transports — the acts that need a configured vault.
    render(<SettingsScreen view={fixtureView()} />);
    expect(screen.getByRole("button", { name: "Configure vault" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Pull vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Push vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Sync vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Hydrate vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Import vault keys" }).hasAttribute("disabled")).toBe(true);
  });

  it("never renders credential or passphrase text — the fold carries booleans only", () => {
    render(<SettingsScreen view={richView()} />);
    // The configured fixture's passphrase value (never modeled) and any
    // secret material can only appear if a future fold regressed to carrying
    // values; the boolean vocabulary is all the DOM may hold.
    const text = document.body.textContent ?? "";
    for (const word of ["passphrase value", "storePass", "BEGIN PRIVATE KEY", "type=\"password\""]) {
      expect(text.includes(word), word).toBe(false);
    }
  });
});
