/**
 * The Settings screen's round-trip write journeys (T-10c): the Owner's two
 * remaining vault acts through their transport slots — the Sync confirm
 * (`factory.vault.sync`: mergeLedgers / includeLedger / overwriteConfigs
 * checkboxes, every one default off) and the Hydrate confirm
 * (`factory.vault.hydrate`: mergeLedgers / overwriteConfigs checkboxes,
 * default off, overwriteConfigs visibly marked destructive). Cancel sends
 * nothing; the confirm sends exactly the checked booleans — the console's
 * sync never carries repo/branch/passphrase (configure owns them) and its
 * hydrate never carries repo/ref (the configured vault is the one that
 * hydrates); the door's narrowing refusals ride as data like any handler's.
 * A success banner carries the handler's own `summary` plus the sync
 * reply's createdRepo/pushed facts and fires the shell's refresh
 * (`onChanged`); a refusal keeps the dialog for another try. The transport
 * buttons stay disabled until the vault is configured — same law as Pull
 * and Push.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryView, VaultStatusView } from "../../../plugin/shared/view.ts";
import type { VaultHydrateReply, VaultSyncReply } from "../vault.ts";
import { fixtureView } from "../test/fixture-view.ts";
import { SettingsScreen } from "./settings.tsx";

afterEach(() => {
  cleanup();
});

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

/** The configured vault — the round-trip acts' own facts. */
const configuredView = (): FactoryView => {
  const view = fixtureView();
  view.vault = vault({ configured: true, repo: "octocat/factory-vault", branch: "release", hasPassphrase: true, cloneExists: true });
  return view;
};

/** The handler's own sync sentence — the banner carries it verbatim. */
const SYNC_SUMMARY =
  "Vault synced with octocat/factory-vault (main): hydrated 0 file(s), pushed 1 file(s); history not requested; materialization applied.";

describe("the sync gate — the confirm names the act and carries only checkboxes", () => {
  it("opens with all three checkboxes default off — Cancel sends nothing", async () => {
    const vaultSync = vi.fn(async (): Promise<VaultSyncReply> => ({ ok: true, vault: vault({ configured: true }), createdRepo: false, hydratedFiles: [], pushedFiles: [], pushed: false, summary: SYNC_SUMMARY }));
    render(<SettingsScreen view={configuredView()} vaultSync={vaultSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync vault" }));
    const dialog = screen.getByRole("dialog", { name: "Sync vault now?" });
    // The confirm names the act and carries the configured facts.
    expect(within(dialog).getByText(/unified bidirectional sync against octocat\/factory-vault/)).toBeTruthy();
    expect(within(dialog).getAllByText("release").length).toBeGreaterThan(0);
    for (const label of [/Merge the vault's node ledger/, /Snapshot this machine's ledgers/, /Overwrite this machine's vault-backed configs/]) {
      expect((within(dialog).getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(false);
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultSync).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the unchecked confirm sends every checkbox off — checked sends exactly the checked booleans, never repo/branch/passphrase", async () => {
    const vaultSync = vi.fn(async (): Promise<VaultSyncReply> => ({ ok: true, vault: vault({ configured: true }), createdRepo: false, hydratedFiles: [], pushedFiles: ["state/nodes/node-1/global-ledger.jsonl"], pushed: true, summary: SYNC_SUMMARY }));
    const onChanged = vi.fn();
    const first = render(<SettingsScreen view={configuredView()} vaultSync={vaultSync} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync vault" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sync vault now?" })).getByRole("button", { name: "Sync vault now" }));
    await waitFor(() => expect(vaultSync).toHaveBeenCalledTimes(1));
    // Every checkbox rides explicitly — the core's own on-by-default sync legs never fire unbidden.
    expect(vaultSync).toHaveBeenCalledWith({ mergeLedgers: false, includeLedger: false, overwriteConfigs: false });
    expect((await screen.findByRole("status")).textContent).toContain("Syncing the vault");
    expect((await screen.findByRole("status")).textContent).toContain(SYNC_SUMMARY);
    expect((await screen.findByRole("status")).textContent).toContain("(pushed)");
    expect(onChanged).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = render(<SettingsScreen view={configuredView()} vaultSync={vaultSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync vault" }));
    const dialog = screen.getByRole("dialog", { name: "Sync vault now?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Merge the vault's node ledger/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Snapshot this machine's ledgers/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Overwrite this machine's vault-backed configs/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync vault now" }));
    await waitFor(() => expect(vaultSync).toHaveBeenCalledTimes(2));
    // Exactly the three checked booleans — never a repo, branch, or passphrase field.
    expect(vaultSync).toHaveBeenLastCalledWith({ mergeLedgers: true, includeLedger: true, overwriteConfigs: true });
    second.unmount();
  });

  it("a createdRepo success folds its fact beside the summary — and a refusal keeps the dialog for another try", async () => {
    let refuse = true;
    const vaultSync = vi.fn(async (): Promise<VaultSyncReply> =>
      refuse
        ? { ok: false, code: "forbidden_operation", error: "factory.vault.sync refuses repo from the console — configure owns the repo, branch, and passphrase; sync runs the configured vault" }
        : { ok: true, vault: vault({ configured: true }), createdRepo: true, hydratedFiles: [], pushedFiles: [], pushed: false, summary: "Vault synced with octocat/factory-vault (main): created private repo octocat/factory-vault; hydrated 0 file(s), up to date (0 file(s) tracked)." },
    );
    render(<SettingsScreen view={configuredView()} vaultSync={vaultSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync vault" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sync vault now?" })).getByRole("button", { name: "Sync vault now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("refused (forbidden_operation)");
    expect(alert.textContent).toContain("configure owns the repo, branch, and passphrase");
    // The refusal keeps the confirm for another try — the retry lands.
    const retry = screen.getByRole("dialog", { name: "Sync vault now?" });
    refuse = false;
    fireEvent.click(within(retry).getByRole("button", { name: "Sync vault now" }));
    await waitFor(() => expect(vaultSync).toHaveBeenCalledTimes(2));
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("created private repo");
    expect(status.textContent).toContain("(repo created; nothing to push)");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the hydrate gate — the destructive checkbox is the only marked one", () => {
  it("opens with both checkboxes default off and overwriteConfigs visibly destructive — Cancel sends nothing", async () => {
    const vaultHydrate = vi.fn(async (): Promise<VaultHydrateReply> => ({ ok: true, vault: vault({ configured: true }), hydratedFiles: ["config/lanes.json"], summary: "Direct hydrate unpacked 1 file(s) from octocat/factory-vault; materialization applied." }));
    render(<SettingsScreen view={configuredView()} vaultHydrate={vaultHydrate} />);
    fireEvent.click(screen.getByRole("button", { name: "Hydrate vault" }));
    const dialog = screen.getByRole("dialog", { name: "Hydrate vault now?" });
    expect(within(dialog).getByText(/streams octocat\/factory-vault's tarball directly/)).toBeTruthy();
    expect(within(dialog).getAllByText("release").length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("checkbox", { name: /Snapshot this machine's ledgers/ })).toBeNull();
    for (const label of [/Merge the vault's node ledger/, /Overwrite this machine's vault-backed configs/]) {
      expect((within(dialog).getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(false);
    }
    const destructiveHint = within(dialog).getAllByText(/overwriteConfigs — DESTRUCTIVE/)[0]!;
    expect(destructiveHint.className).toContain("red");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(vaultHydrate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the unchecked confirm sends every checkbox off — checked sends exactly the two booleans, never repo/ref", async () => {
    const vaultHydrate = vi.fn(async (): Promise<VaultHydrateReply> => ({ ok: true, vault: vault({ configured: true }), hydratedFiles: [], summary: "Direct hydrate unpacked 0 file(s) from octocat/factory-vault; materialization applied." }));
    const onChanged = vi.fn();
    const first = render(<SettingsScreen view={configuredView()} vaultHydrate={vaultHydrate} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Hydrate vault" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Hydrate vault now?" })).getByRole("button", { name: "Hydrate vault now" }));
    await waitFor(() => expect(vaultHydrate).toHaveBeenCalledTimes(1));
    expect(vaultHydrate).toHaveBeenCalledWith({ mergeLedgers: false, overwriteConfigs: false });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Hydrating the vault");
    expect(status.textContent).toContain("Direct hydrate unpacked 0 file(s)");
    expect(onChanged).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = render(<SettingsScreen view={configuredView()} vaultHydrate={vaultHydrate} />);
    fireEvent.click(screen.getByRole("button", { name: "Hydrate vault" }));
    const dialog = screen.getByRole("dialog", { name: "Hydrate vault now?" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Merge the vault's node ledger/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Overwrite this machine's vault-backed configs/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Hydrate vault now" }));
    await waitFor(() => expect(vaultHydrate).toHaveBeenCalledTimes(2));
    expect(vaultHydrate).toHaveBeenLastCalledWith({ mergeLedgers: true, overwriteConfigs: true });
    second.unmount();
  });
});

describe("the transport buttons — the configured gate", () => {
  it("keeps Sync and Hydrate disabled until the vault is configured", () => {
    const view = fixtureView();
    view.vault = vault();
    render(<SettingsScreen view={view} />);
    expect(screen.getByRole("button", { name: "Sync vault" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Hydrate vault" }).hasAttribute("disabled")).toBe(true);
  });
});
